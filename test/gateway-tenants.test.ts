import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basicCredentials, BilinfoClient, CREDENTIAL_HEADER, DEFAULT_BASE_URL } from '../src/bilinfo/client.js';
import { createBilinfoGateway, bilinfoGatewayTools, bilinfoToolCatalog } from '../src/gateway.js';
import { BILINFO_TOOLS } from '../src/tools/bilinfo.js';
import {
  ACCESS_TOKEN,
  BASE,
  EXPORT_URL,
  FJORDBY,
  NORDKYST,
  PLUGIN_ID,
  SERVICES,
  USERNAME,
  auditLines,
  connect,
  exportBody,
  exportRoutes,
  fullOptions,
  gatewayOptions,
  listingId,
  sampleStock,
  stubFetch,
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
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Placeholder credentials, built at runtime: long enough to be redacted by value. */
const fakeKey = (label: string) => `${label}-${'x'.repeat(12)}`;
// Passwords with no piece of six characters in common: the redactor also removes any such piece of its own password.
const KEY_A = 'alpha-0123456789-kq';
const KEY_B = 'bravo-zyxwvutsrq-MP';
const ENV_KEY = 'envkey-ABCDEFGHIJ-77';

/** Upstream that answers every request with an error body echoing `echo`. */
function echoingFetch(echo: string) {
  return vi.fn(
    async () =>
      new Response(`upstream rejected credentials ${echo}`, { status: 400, headers: { 'content-type': 'text/plain' } }),
  ) as unknown as typeof fetch;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function create(password: string, extra: Parameters<typeof gatewayOptions>[0] = {}) {
  return createBilinfoGateway(gatewayOptions({ password, ...extra }));
}

describe('explicit gateway credentials', () => {
  it('requires username and password and ignores the environment', () => {
    process.env.BILINFO_USERNAME = 'env-user';
    process.env.BILINFO_PASSWORD = ENV_KEY;

    expect(() => createBilinfoGateway({ username: USERNAME } as never)).toThrow(/options\.username and options\.password together/);
    expect(() => createBilinfoGateway({ password: KEY_A } as never)).toThrow(/together/);
    expect(() => createBilinfoGateway({ username: USERNAME, password: '' })).toThrow(/together/);
    expect(() => createBilinfoGateway({ username: '', password: KEY_A })).toThrow(/together/);
    expect(() => createBilinfoGateway(undefined as never)).toThrow(/requires options\.username and options\.password/);
  });

  it('never reads credential variables from process.env, even when they are set', async () => {
    const reads = new Set<string>();
    const env = {
      ...process.env,
      BILINFO_USERNAME: 'env-user',
      BILINFO_PASSWORD: ENV_KEY,
      BILINFO_DEALER_ID: NORDKYST.DealerGuid,
      BILINFO_BASE_URL: 'https://elsewhere.bilinfo.net/listingapi',
      BILINFO_CLIENT_ID: 'env-client',
      BILINFO_CLIENT_SECRET: ENV_KEY,
      BILINFO_PLUGIN_ID: 'env-plugin',
      BILINFO_ENVIRONMENT: 'qa',
    };
    process.env = new Proxy(env, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          reads.add(property);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => createBilinfoGateway({ username: USERNAME } as never)).toThrow(/together/);

    const fetchImpl = stubFetch(exportRoutes(sampleStock()));
    const gw = create(KEY_A, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await gw.callTool('stock_overview', {});
    expect(result.isError).toBeUndefined();
    expect(headersOf(fetchImpl.mock.calls[0]?.[1])[CREDENTIAL_HEADER]).toBe(`Basic ${basicCredentials(USERNAME, KEY_A)}`);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(EXPORT_URL);

    for (const name of [
      'BILINFO_USERNAME',
      'BILINFO_PASSWORD',
      'BILINFO_DEALER_ID',
      'BILINFO_BASE_URL',
      'BILINFO_CLIENT_ID',
      'BILINFO_CLIENT_SECRET',
      'BILINFO_PLUGIN_ID',
      'BILINFO_ENVIRONMENT',
    ]) {
      expect(reads.has(name), name).toBe(false);
    }
  });

  it('uses the address of the Listing API when the host gives none', async () => {
    const fetchImpl = vi.fn(async () => Response.json(exportBody([])));
    const gw = createBilinfoGateway({ username: USERNAME, password: KEY_A, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await gw.callTool('stock_overview', {})).isError).toBeUndefined();
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(`${DEFAULT_BASE_URL}/api/export`);
    // Another host is refused unless the host says it is meant.
    expect(() => createBilinfoGateway({ username: USERNAME, password: KEY_A, baseUrl: 'https://elsewhere.test/listingapi' })).toThrow(
      'bilinfo.net',
    );
  });

  it('still reads credentials from the environment in the standalone client', async () => {
    process.env.BILINFO_USERNAME = 'env-user';
    process.env.BILINFO_PASSWORD = ENV_KEY;
    process.env.BILINFO_BASE_URL = 'http://127.0.0.1:1/listingapi';
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    await new BilinfoClient({ fetchImpl }).get('/api/export');
    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit)[CREDENTIAL_HEADER]).toBe(`Basic ${basicCredentials('env-user', ENV_KEY)}`);
  });
});

describe('one dealer per instance', () => {
  it('limits every read to the dealer of the instance, and reads the whole account without one', async () => {
    const urlsOf = (fetchImpl: ReturnType<typeof stubFetch>) => fetchImpl.mock.calls.map(([url]) => String(url));
    const fetchA = stubFetch(exportRoutes([vehicle(1)]));
    const fetchB = stubFetch(exportRoutes([vehicle(2, NORDKYST)]));
    const fetchAll = stubFetch(exportRoutes([vehicle(1), vehicle(2, NORDKYST)]));
    const a = create(KEY_A, { dealerId: FJORDBY.DealerGuid, fetchImpl: fetchA as unknown as typeof fetch });
    const b = create(KEY_A, { dealerId: NORDKYST.DealerGuid.toUpperCase(), fetchImpl: fetchB as unknown as typeof fetch });
    const all = create(KEY_A, { fetchImpl: fetchAll as unknown as typeof fetch });

    await Promise.all([a.callTool('list_vehicles', {}), b.callTool('stock_overview', {}), all.callTool('list_vehicles', {})]);
    await a.callTool('get_vehicle', { vehicleId: listingId(1) });

    expect(urlsOf(fetchA)).toEqual([`${EXPORT_URL}?dealerId=${FJORDBY.DealerGuid}`, `${EXPORT_URL}?dealerId=${FJORDBY.DealerGuid}`]);
    expect(urlsOf(fetchB)).toEqual([`${EXPORT_URL}?dealerId=${NORDKYST.DealerGuid}`]);
    expect(urlsOf(fetchAll)).toEqual([EXPORT_URL]);
  });

  it('takes the dealer from the instance only: no tool has an input for it', () => {
    for (const tool of bilinfoGatewayTools) {
      const properties = Object.keys((tool.inputSchema.properties ?? {}) as object).map(name => name.toLowerCase());
      expect(properties.filter(name => name.includes('dealer')), tool.name).toEqual([]);
    }
  });
});

describe('nothing is kept between calls', () => {
  it('reads from Bilinfo on every call, and answers with what Bilinfo says now', async () => {
    let stock = [vehicle(1)];
    const fetchImpl = vi.fn(async () => Response.json(exportBody(stock)));
    const gw = create(KEY_A, { fetchImpl: fetchImpl as unknown as typeof fetch });

    const first = await gw.callTool('stock_overview', {});
    expect(first.structuredContent).toMatchObject({ listings: 1 });
    // The car is sold and another one added between the two calls.
    stock = [vehicle(2), vehicle(3)];
    const second = await gw.callTool('stock_overview', {});
    expect(second.structuredContent).toMatchObject({ listings: 2 });
    const gone = await gw.callTool('get_vehicle', { vehicleId: listingId(1) });
    expect(gone.isError).toBe(true);
    await gw.callTool('list_vehicles', {});
    await gw.callTool('list_vehicles', {});
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});

describe('per-instance redaction', () => {
  it('redacts each instance’s own password in its tool results', async () => {
    const a = create(KEY_A, { fetchImpl: echoingFetch(KEY_A) });
    const b = create(KEY_B, { fetchImpl: echoingFetch(KEY_B) });

    const resultA = texts(await a.callTool('stock_overview', {})).join(' ');
    const resultB = texts(await b.callTool('stock_overview', {})).join(' ');
    // The echoing error body is never read into the result; the password is not there in any form.
    expect(resultA).not.toContain(KEY_A);
    expect(resultB).not.toContain(KEY_B);
  });

  it('keeps redactors separate: an instance holds only its own secrets', () => {
    const a = new BilinfoClient({ username: USERNAME, password: KEY_A, credentialEnv: {} });
    const b = new BilinfoClient({ username: USERNAME, password: KEY_B, credentialEnv: {} });
    expect(a.redactor.hasSecret(KEY_A)).toBe(true);
    expect(a.redactor.hasSecret(basicCredentials(USERNAME, KEY_A))).toBe(true);
    expect(a.redactor.hasSecret(KEY_B)).toBe(false);
    expect(b.redactor.hasSecret(KEY_B)).toBe(true);
    expect(b.redactor.hasSecret(KEY_A)).toBe(false);
    expect(b.redactor.hasSecret(basicCredentials(USERNAME, KEY_A))).toBe(false);
    // B neither knows nor needs A's password: its text is only redacted for its own.
    expect(b.redactor.redact(`a=${KEY_A} b ${KEY_B}`)).toBe(`a=${KEY_A} b ‹redacted›`);
  });

  it('does not accumulate passwords of earlier instances', () => {
    for (let index = 0; index < 200; index += 1) {
      create(`short-lived-key-${index}`);
    }
    const fresh = new BilinfoClient({ username: USERNAME, password: KEY_A, credentialEnv: {} });
    expect(fresh.redactor.redact('short-lived-key-7')).toBe('short-lived-key-7');
  });

  it('redacts audit records with the password of the instance that ran the call', async () => {
    process.env.BILINFO_AUDIT_LOG = join(dir, 'audit.jsonl');
    const failing = (key: string) =>
      vi.fn(async () => {
        throw new TypeError(`connection refused while sending ${key}`);
      }) as unknown as typeof fetch;
    const a = create(KEY_A, { fetchImpl: failing(KEY_A), maxAttempts: 1 });
    const b = create(KEY_B, { fetchImpl: failing(KEY_B), maxAttempts: 1 });
    await a.callTool('stock_overview', {}, { requestId: 'a' });
    await b.callTool('stock_overview', {}, { requestId: 'b' });

    const errors = auditLines(process.env.BILINFO_AUDIT_LOG).filter(line => line.action === 'error');
    expect(errors.map(line => line.requestId)).toEqual(['a', 'b']);
    const log = JSON.stringify(errors);
    expect(log).not.toContain(KEY_A);
    expect(log).not.toContain(KEY_B);
  });

  it('redacts with the server client’s password on the MCP path', async () => {
    const tool = BILINFO_TOOLS.find(t => t.name === 'bilinfo_stock_overview')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed with kode-til-test-4711');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'bilinfo_stock_overview', arguments: {} });
      expect(texts(result).join(' ')).not.toContain('kode-til-test-4711');
    } finally {
      tool.handler = original;
    }
  });

  it('lets a dropped instance and its password be garbage collected', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let gateway: ReturnType<typeof createBilinfoGateway> | undefined = create(fakeKey('collectable'));
    const ref = new WeakRef(gateway);
    gateway = undefined;
    for (let attempt = 0; attempt < 10 && ref.deref(); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
  });
});

/** Sample input per tool, used to check each tool's declared upstream requests. */
const SAMPLE_INPUTS: Record<string, Record<string, unknown>> = {
  list_vehicles: { make: 'Skoda' },
  get_vehicle: { vehicleId: listingId(1) },
  stock_overview: {},
  find_dealer: { cvr: '12345678' },
  list_users: {},
  report_application_status: { reference: 'sag-0001', loan: { status: 3, statusText: 'Godkendt', providerName: 'Eksempel Finans' } },
};

/** What each service answers in the catalog test: the vehicles, an empty list, or nothing. */
const SERVICE_ANSWERS: Record<string, unknown> = { listing: exportBody(sampleStock()), dealerLookup: [], userLookup: [], casePlugin: null };
/** Base path of each service on the test hosts. */
const SERVICE_BASES: Record<string, string> = { listing: BASE, ...SERVICES };

describe('tool catalog', () => {
  it('lists every registered tool, matching the gateway definitions', async () => {
    expect(bilinfoToolCatalog.map(entry => entry.name)).toEqual(bilinfoGatewayTools.map(tool => tool.name));
    for (const entry of bilinfoToolCatalog) {
      const { upstream, broad, ...definition } = entry;
      expect(typeof broad).toBe('boolean');
      if (broad) expect(entry.riskLevel).toBe('read');
      expect(definition).toEqual(bilinfoGatewayTools.find(tool => tool.name === entry.name));
      expect(upstream.length).toBeGreaterThan(0);
      for (const operation of upstream) {
        expect(operation.access === 'read' ? operation.method === 'GET' : true).toBe(true);
        if (entry.riskLevel === 'read') {
          expect(operation.access).toBe('read');
        }
      }
    }
    // One tool changes something in Bilinfo; every other tool reads.
    expect(bilinfoToolCatalog.filter(entry => entry.riskLevel !== 'read').map(entry => entry.name)).toEqual(['report_application_status']);

    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(
      bilinfoToolCatalog.map(entry => `bilinfo_${entry.name}`).sort(),
    );
    for (const tool of tools) {
      const entry = bilinfoToolCatalog.find(e => `bilinfo_${e.name}` === tool.name)!;
      expect(entry.title).toBe(tool.title);
      expect(entry.description).toBe(tool.description);
      expect(Object.keys(entry.inputSchema.properties as object).sort()).toEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
      );
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(bilinfoToolCatalog)).toBe(true);
    const visit = (value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(visit);
      }
    };
    visit(bilinfoToolCatalog);
    expect(() => {
      (bilinfoToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow(TypeError);
  });

  it('declares exactly the upstream requests each tool makes', async () => {
    for (const entry of bilinfoToolCatalog) {
      const input = SAMPLE_INPUTS[entry.name];
      expect(input, `sample input for ${entry.name}`).toBeDefined();
      const service = entry.upstream[0]!.service;
      const fetchImpl = vi.fn(async (url: string) =>
        url === SERVICES.token
          ? Response.json({ access_token: ACCESS_TOKEN, expires_in: 360, token_type: 'Bearer' })
          : Response.json(SERVICE_ANSWERS[service]),
      );
      const gw = createBilinfoGateway(fullOptions({ fetchImpl: fetchImpl as unknown as typeof fetch, policy: { enableWrites: true } }));
      const result = await gw.callTool(entry.name, input! as never);
      expect(result.isError, texts(result).join(' ')).toBeUndefined();

      const values: Record<string, unknown> = { ...input, pluginId: PLUGIN_ID, dealerId: FJORDBY.DealerGuid };
      const declared = entry.upstream.map(op => ({
        method: op.method,
        path: op.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(values[name] ?? ''))),
      }));
      const base = SERVICE_BASES[service]!;
      const made = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)
        // Asking for the access token is not a request of the tool's own: every tool but the Listing API's makes it.
        .filter(([url]) => url !== SERVICES.token)
        .map(([url, init]) => {
          expect(url.startsWith(base), `${entry.name} called ${new URL(url).host}`).toBe(true);
          return { method: init.method, path: new URL(url).pathname.slice(new URL(base).pathname.replace(/\/$/, '').length) };
        });
      expect(made, entry.name).toHaveLength(1);
      for (const request of made) {
        expect(declared, `${entry.name} made ${request.method} ${request.path}`).toContainEqual(request);
      }
    }
  });
});
