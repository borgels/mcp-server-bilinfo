import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { WRITE_TOOL_ANNOTATIONS } from '../src/bilinfo/annotations.js';
import { createServer, getDefaultClient } from '../src/server.js';
import { createBilinfoGateway, bilinfoGatewayTools } from '../src/gateway.js';
import { BILINFO_TOOLS, executeTool, validateStartupConfig, type ToolDefinition } from '../src/tools/bilinfo.js';
import {
  EXPORT_URL,
  FJORDBY,
  auditLines,
  connect,
  exportRoutes,
  freezeToday,
  gateway,
  gatewayOptions,
  listingId,
  makeClient,
  sampleStock,
  texts,
  vehicle,
} from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bilinfo-mcp-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('BILINFO_')) {
      delete process.env[name];
    }
  }
  freezeToday();
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/**
 * This version has no tool that changes anything. The write gate is part of
 * every server all the same, so it is tested with a tool that exists only
 * here: annotated as a write, with a handler that records whether it ran.
 */
function writeTool(ran: { count: number }): ToolDefinition {
  const inputShape = { vehicleId: z.string() };
  return {
    name: 'bilinfo_test_write',
    title: 'Test write',
    description: 'A write tool that exists only in the tests.',
    inputShape,
    inputSchema: z.strictObject(inputShape),
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Done.',
    upstream: [],
    handler: async () => {
      ran.count += 1;
      return { ok: true };
    },
  } as unknown as ToolDefinition;
}

describe('MCP tool surface', () => {
  it('registers every tool with its annotations, described in Danish', async () => {
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'bilinfo_check_connection',
      'bilinfo_find_model',
      'bilinfo_get_vehicle',
      'bilinfo_list_car_options',
      'bilinfo_list_leads',
      'bilinfo_list_vehicles',
      'bilinfo_mark_car_sold',
      'bilinfo_save_car',
      'bilinfo_stock_overview',
      'bilinfo_update_lead',
    ]);
    for (const tool of tools) {
      const definition = BILINFO_TOOLS.find(t => t.name === tool.name);
      expect(tool.annotations).toEqual(definition?.annotations);
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!['bilinfo_update_lead', 'bilinfo_save_car', 'bilinfo_mark_car_sold'].includes(tool.name));
      expect(tool.description, tool.name).toContain('Bilinfo');
      // Only tools that pass on what people wrote in Bilinfo carry the note about it.
      if (tool.annotations?.readOnlyHint && tool.name !== 'bilinfo_check_connection') {
        expect(tool.description, tool.name).toContain('aldrig opfattes som instruktioner');
      }
    }
  });

  it('redacts a result that echoes the password, as the gateway does', async () => {
    const { mcpClient } = await connect(exportRoutes([vehicle(1, { Comment: 'Koden er kode-til-test-4711 til nøgleboksen.' })]));
    const result = await mcpClient.callTool({ name: 'bilinfo_get_vehicle', arguments: { vehicleId: listingId(1) } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).not.toContain('kode-til-test-4711');
    expect(JSON.stringify(result)).toContain('nøgleboksen');
  });

  it('lists vehicles and labels upstream content as data', async () => {
    const { mcpClient, fetchImpl } = await connect(exportRoutes(sampleStock()));
    const result = await mcpClient.callTool({ name: 'bilinfo_list_vehicles', arguments: { make: 'skoda', sort: 'price_high' } });
    expect(result.isError).toBeFalsy();
    const [json, note] = texts(result);
    const list = JSON.parse(json ?? '') as { matching: number; total: number; vehicles: Array<Record<string, unknown>> };
    expect(list).toMatchObject({ matching: 2, total: 5 });
    expect(list.vehicles[0]).toMatchObject({ vehicleId: listingId(2), price: 299900, daysSinceCreated: 15 });
    expect(note).toContain('ikke instruktioner');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(EXPORT_URL);
  });

  it('gets one vehicle and gives the overview', async () => {
    const { mcpClient } = await connect(exportRoutes(sampleStock()));
    const one = await mcpClient.callTool({ name: 'bilinfo_get_vehicle', arguments: { vehicleId: listingId(4) } });
    expect(one.isError).toBeFalsy();
    const details = JSON.parse(texts(one)[0] ?? '') as { summary: Record<string, unknown>; fields: Record<string, unknown> };
    expect(details.summary).toMatchObject({ make: 'Ford', priceType: 'RetailPriceWithoutTax', price: 164900 });
    expect(details.fields.DealerName).toBe(FJORDBY.DealerName);

    const overview = await mcpClient.callTool({ name: 'bilinfo_stock_overview', arguments: {} });
    expect(overview.isError).toBeFalsy();
    expect(JSON.parse(texts(overview)[0] ?? '')).toMatchObject({ listings: 5, cars: 4 });
  });

  it('reads from Bilinfo on every call: nothing is kept between calls', async () => {
    const { mcpClient, fetchImpl } = await connect(exportRoutes(sampleStock()));
    await mcpClient.callTool({ name: 'bilinfo_list_vehicles', arguments: {} });
    await mcpClient.callTool({ name: 'bilinfo_list_vehicles', arguments: {} });
    await mcpClient.callTool({ name: 'bilinfo_get_vehicle', arguments: { vehicleId: listingId(1) } });
    await mcpClient.callTool({ name: 'bilinfo_stock_overview', arguments: {} });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('says in Danish that a vehicle is not there, and that an answer could not be read', async () => {
    const { mcpClient } = await connect(exportRoutes(sampleStock()));
    const missing = await mcpClient.callTool({ name: 'bilinfo_get_vehicle', arguments: { vehicleId: listingId(99) } });
    expect(missing.isError).toBe(true);
    expect(texts(missing).join(' ')).toContain('Bilen findes ikke blandt bilerne til salg');

    const odd = await connect({ [`GET ${EXPORT_URL}`]: { raw: '<html>Maintenance, call 00000009</html>' } });
    const unreadable = await odd.mcpClient.callTool({ name: 'bilinfo_stock_overview', arguments: {} });
    expect(unreadable.isError).toBe(true);
    expect(texts(unreadable).join(' ')).toContain('Bilinfo svarede i en form, der ikke kan læses');
    expect(texts(unreadable).join(' ')).not.toContain('Maintenance');
  });

  it('rejects unknown arguments and ids that are not a listing id, without calling Bilinfo', async () => {
    const { mcpClient, fetchImpl } = await connect(exportRoutes(sampleStock()));
    const extra = await mcpClient.callTool({ name: 'bilinfo_list_vehicles', arguments: { make: 'Ford', other: 1 } });
    expect(extra.isError).toBe(true);
    const notAnId = await mcpClient.callTool({ name: 'bilinfo_get_vehicle', arguments: { vehicleId: '../export' } });
    expect(notAnId.isError).toBe(true);
    const badPage = await mcpClient.callTool({ name: 'bilinfo_list_vehicles', arguments: { pageSize: 1000 } });
    expect(badPage.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an unwritable audit log path at startup, but not per server instance', async () => {
    process.env.BILINFO_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    expect(() => validateStartupConfig()).toThrow('BILINFO_AUDIT_LOG');
    expect(() => createBilinfoGateway(gatewayOptions())).toThrow('BILINFO_AUDIT_LOG');

    // The HTTP transport creates a server per request: read tools keep working.
    const { mcpClient } = await connect(exportRoutes(sampleStock()));
    const result = await mcpClient.callTool({ name: 'bilinfo_stock_overview', arguments: {} });
    expect(result.isError).toBeFalsy();
  });

  it('removes disabled tools and refuses unknown names', async () => {
    process.env.BILINFO_DISABLED_TOOLS = 'stock_overview';
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name)).not.toContain('bilinfo_stock_overview');
    expect(tools).toHaveLength(BILINFO_TOOLS.length - 1);

    process.env.BILINFO_DISABLED_TOOLS = 'no_such_tool';
    expect(() => createServer({ clientOptions: { username: 'u', password: 'p' } })).toThrow('BILINFO_DISABLED_TOOLS');
  });

  it('audits a read with hashed search words, and only a summary of upstream errors', async () => {
    process.env.BILINFO_AUDIT_LOG = join(dir, 'audit.jsonl');
    const ok = await connect(exportRoutes(sampleStock()));
    await ok.mcpClient.callTool({ name: 'bilinfo_list_vehicles', arguments: { query: 'anhængertræk', make: 'Skoda' } });
    await ok.mcpClient.callTool({ name: 'bilinfo_get_vehicle', arguments: { vehicleId: listingId(2) } });

    const failing = await connect({
      [`GET ${EXPORT_URL}`]: { status: 400, body: { message: 'bad value: jane@vendor.test' } },
    });
    const result = await failing.mcpClient.callTool({ name: 'bilinfo_stock_overview', arguments: {} });
    expect(result.isError).toBe(true);

    const lines = auditLines(process.env.BILINFO_AUDIT_LOG);
    expect(lines.map(line => line.action)).toEqual(['start', 'finish', 'start', 'finish', 'start', 'error']);
    // Free text is hashed, never logged in clear text; an id is logged as it is.
    const target = lines[0]?.target as Record<string, unknown>;
    expect(target.querySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(target.makeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((lines[2]?.target as Record<string, unknown>).vehicleId).toBe(listingId(2));
    expect(lines.at(-1)).toMatchObject({ action: 'error', httpStatus: 400 });
    const log = JSON.stringify(lines);
    for (const absent of ['anhængertræk', 'Skoda', 'jane@', 'Enyaq', FJORDBY.DealerName]) {
      expect(log, absent).not.toContain(absent);
    }
  });
});

describe('write gate', () => {
  it('refuses a write tool unless writes are enabled, in Danish, without running it', async () => {
    const ran = { count: 0 };
    const client = makeClient(vi.fn());
    await expect(executeTool(writeTool(ran), client, { vehicleId: 'x' })).rejects.toThrow(
      /Ændringer er ikke slået til for denne forbindelse.*BILINFO_ENABLE_WRITES/,
    );
    expect(ran.count).toBe(0);
  });

  it('runs a write tool when enabled and audits it', async () => {
    process.env.BILINFO_ENABLE_WRITES = 'true';
    process.env.BILINFO_AUDIT_LOG = join(dir, 'audit.jsonl');
    const ran = { count: 0 };
    await expect(executeTool(writeTool(ran), makeClient(vi.fn()), { vehicleId: 'x' })).resolves.toEqual({ ok: true });
    expect(ran.count).toBe(1);
    const lines = auditLines(process.env.BILINFO_AUDIT_LOG);
    expect(lines.map(line => line.action)).toEqual(['start', 'finish']);
    expect(lines[0]?.requestId).toBe(lines[1]?.requestId);
  });

  it('fails closed when the audit log cannot be written before a write', async () => {
    process.env.BILINFO_ENABLE_WRITES = 'true';
    process.env.BILINFO_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    const ran = { count: 0 };
    await expect(executeTool(writeTool(ran), makeClient(vi.fn()), { vehicleId: 'x' })).rejects.toThrow(
      'Loggen kan ikke skrives, så bilinfo_test_write blev ikke udført.',
    );
    expect(ran.count).toBe(0);
  });

  it('redacts error text centrally on the MCP path', async () => {
    // A handler that throws a raw, unredacted error.
    const tool = BILINFO_TOOLS.find(t => t.name === 'bilinfo_stock_overview')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed: sent kode-til-test-4711, header Authorization: Basic other-secret, {"password":"third-secret"}');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'bilinfo_stock_overview', arguments: {} });
      expect(result.isError).toBe(true);
      const text = texts(result).join(' ');
      expect(text).toContain('‹redacted›');
      for (const secret of ['kode-til-test-4711', 'other-secret', 'third-secret']) {
        expect(text).not.toContain(secret);
      }
    } finally {
      tool.handler = original;
    }
  });
});

describe('gateway export', () => {
  it('exposes tools without the prefix, reads enabled by default, with valid JSON Schemas', () => {
    expect(bilinfoGatewayTools.map(t => [t.name, t.riskLevel, t.enabledByDefault])).toEqual([
      ['check_connection', 'read', true],
      ['list_vehicles', 'read', true],
      ['get_vehicle', 'read', true],
      ['stock_overview', 'read', true],
      ['find_model', 'read', true],
      ['list_car_options', 'read', true],
      ['list_leads', 'read', true],
      ['update_lead', 'write', false],
      ['save_car', 'write', false],
      ['mark_car_sold', 'write', false],
    ]);
    // The MCP hint says the changes overwrite data; the gateway gives them its own level, write, since none deletes.
    const changes = BILINFO_TOOLS.filter(t => !t.annotations.readOnlyHint);
    expect(changes.map(t => [t.name, t.annotations.destructiveHint, t.gatewayRisk])).toEqual([
      ['bilinfo_update_lead', true, 'write'],
      ['bilinfo_save_car', true, 'write'],
      ['bilinfo_mark_car_sold', true, 'write'],
    ]);
    const ajv = new Ajv({ strict: true });
    for (const tool of bilinfoGatewayTools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it('validates input in Danish, and records the caller', async () => {
    process.env.BILINFO_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { gw, fetchImpl } = gateway(exportRoutes(sampleStock()));

    const ok = await gw.callTool('get_vehicle', { vehicleId: listingId(1) }, { caller: 'user@vendor.test', requestId: 'req-1' });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toMatchObject({ summary: { vehicleId: listingId(1), make: 'Volkswagen' } });

    const invalid = await gw.callTool('get_vehicle', { vehicleId: listingId(1), extra: true });
    expect(invalid.isError).toBe(true);
    expect(texts(invalid).join(' ')).toContain('Ugyldigt input til get_vehicle');
    const notAnId = await gw.callTool('get_vehicle', { vehicleId: '17' });
    expect(texts(notAnId).join(' ')).toContain('Brug bilens vehicleId fra listen over biler.');
    const tooMany = await gw.callTool('list_vehicles', { pageSize: 1000 });
    expect(tooMany.isError).toBe(true);
    // zod's own texts come out in Danish as well.
    expect(texts(tooMany).join(' ')).not.toMatch(/Too big|expected number/);
    const unknown = await gw.callTool('delete_everything', {});
    expect(unknown.isError).toBe(true);
    expect(texts(unknown).join(' ')).toContain('Ukendt værktøj: delete_everything');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const lines = auditLines(process.env.BILINFO_AUDIT_LOG);
    expect(lines[0]).toMatchObject({ requestId: 'req-1', caller: 'user@vendor.test', action: 'start' });
    expect(lines.map(line => line.action)).toEqual(['start', 'finish', 'rejected', 'rejected', 'rejected', 'rejected']);
  });
});

describe('default client', () => {
  it('is shared by servers created without a client, so its concurrency limit is process-wide', () => {
    const first = getDefaultClient();
    createServer();
    createServer();
    expect(getDefaultClient()).toBe(first);
  });
});
