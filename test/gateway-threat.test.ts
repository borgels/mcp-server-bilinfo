// The rest of the threat model (README, "Threat model"), through callTool: a password that is a number and pieces of
// it in numbers, an error while reading a body, a result too deep to serialise naively, passwords that collide with
// our own texts, and failures of the audit sink. Every result must still be valid JSON.
import { describe, expect, it, vi } from 'vitest';
import { createBilinfoGateway } from '../src/gateway.js';
import { exportBody, gatewayOptions, listingId, vehicle } from './helpers.js';

const KEY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const DEEP = 20_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failingBody = (message: string, status = 200) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"Vehicles":'));
        controller.error(new Error(message));
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

function create(password: string, fetchImpl: typeof fetch, extra: Parameters<typeof gatewayOptions>[0] = {}) {
  return createBilinfoGateway(gatewayOptions({ password, fetchImpl, maxAttempts: 1, ...extra }));
}

describe('the threat model, through callTool', () => {
  it('redacts a numeric password in numbers that hold it, and the result stays valid JSON', async () => {
    const key = '1234567890123456';
    const records: unknown[] = [];
    const echoing = vehicle(1, {
      Version: Number(key),
      Technical: { n: [Number(key.slice(1, 7)), Number(`${key}9`)] },
      Available: true,
      Seats: 5,
    });
    const gw = create(key, async () => json(exportBody([echoing])), { policy: { audit: r => void records.push(r) } });
    const result = await gw.callTool('get_vehicle', { vehicleId: listingId(1) });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { fields: Record<string, unknown> }).fields).toMatchObject({
      Version: '‹redacted›',
      Technical: { n: [234567, '‹redacted›'] },
      Available: true,
      Seats: 5,
    });
    const serialised = JSON.stringify(result);
    expect(JSON.parse(serialised)).toEqual(result);
    expect(serialised).not.toContain(key);
    expect(JSON.stringify(records)).not.toContain(key);
  });

  it('turns an error while reading a successful body into a fixed text, for the host and the audit', async () => {
    const records: unknown[] = [];
    // The vendor's text and a piece of the password shorter than six characters.
    const gw = create(KEY, async () => failingBody(`Vendor diagnostic ${KEY.slice(0, 5)}`), { policy: { audit: r => void records.push(r) } });
    const result = await gw.callTool('stock_overview', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Svaret fra Bilinfo kunne ikke læses.');
    for (const value of [result, records]) {
      expect(JSON.stringify(value)).not.toContain('Vendor');
      expect(JSON.stringify(value)).not.toContain(JSON.stringify(KEY.slice(0, 5)).slice(1, -1));
    }
  });

  it('answers a very deep result without exhausting the stack', async () => {
    const body = `{"Vehicles":[{"VehicleId":"${listingId(1)}","Deep":${'['.repeat(DEEP)}1${']'.repeat(DEEP)}}]}`;
    const gw = create(KEY, async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }), {
      maxResponseBytes: 1_000_000,
    });
    const result = await gw.callTool('get_vehicle', { vehicleId: listingId(1) });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).toContain('[nested too deep]');
  });
});

describe('the redaction marker and unreadable bodies', () => {
  it('accepts a password that overlaps the redaction marker, and redacts one that looks like a marker', async () => {
    for (const password of ['‹redacted›-0123456789', 'my-redacted-value', 'xx-dacted›-yy', '‹redacted›']) {
      expect(() => createBilinfoGateway(gatewayOptions({ password })), password).not.toThrow();
    }
    const LOOKALIKE = '[REDACTED]-0123456789';
    const records: unknown[] = [];
    const gw = create(LOOKALIKE, async () => json(exportBody([vehicle(1, { Comment: LOOKALIKE, [LOOKALIKE]: 1 })])), {
      policy: { audit: r => void records.push(r) },
    });
    const results = [
      await gw.callTool('get_vehicle', { vehicleId: listingId(1) }, { caller: LOOKALIKE }),
      await gw.callTool('list_vehicles', { query: LOOKALIKE }, { caller: LOOKALIKE }),
      await gw.callTool('get_vehicle', { vehicleId: LOOKALIKE }, { caller: LOOKALIKE }),
    ];
    const text = JSON.stringify([results, records]);
    expect(text).not.toContain(LOOKALIKE);
    expect(text).toContain('‹redacted›');
  });

  it('gives our own text when the body of a failed response cannot be read', async () => {
    const records: unknown[] = [];
    const gw = create(
      KEY,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`Vendor diagnostic ${KEY.slice(0, 5)}`));
            },
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      { policy: { audit: r => void records.push(r) } },
    );
    const result = await gw.callTool('stock_overview', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Bilinfo svarede med en fejl \(HTTP 500\)/);
    expect(JSON.stringify([result, records])).not.toContain('Vendor');
  });

  it('redacts an audit sink failure before it reaches stderr', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      written.push(String(chunk));
      return true;
    });
    try {
      const gw = create(KEY, async () => json(exportBody([vehicle(1)])), {
        policy: {
          audit: () => {
            throw new Error(`sink failed for ${KEY}`);
          },
        },
      });
      const result = await gw.callTool('stock_overview', {});
      expect(result.isError).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const text = written.join('');
    expect(text).toContain('audit log write failed');
    for (const piece of pieces(KEY)) expect(text, piece).not.toContain(piece);
  });
});

describe('passwords that collide with our own texts', () => {
  it('are accepted like any other, and still never repeated', async () => {
    for (const password of [
      '[nested too deep]-0123456789',
      'bilinfo-mcp-0123456789',
      'BILINFO_BASE_URL-0123456789',
      'Bilinfo2026',
      'instruktioner-17',
    ]) {
      const gw = createBilinfoGateway(
        gatewayOptions({ password, fetchImpl: async () => json(exportBody([vehicle(1, { Comment: `Kode: ${password}` })])) }),
      );
      const results = [
        await gw.callTool('get_vehicle', { vehicleId: listingId(1) }, { caller: password }),
        await gw.callTool(password, {}),
      ];
      expect(results[0]?.isError, password).toBeUndefined();
      expect(JSON.stringify(results), password).not.toContain(password);
    }
  });

  it('sends a construction error through the redactor, configuration values included', () => {
    const HOSTLIKE = 'qz7hn4vb8lw2jx6pz9';
    let message = '';
    try {
      createBilinfoGateway(
        gatewayOptions({ password: HOSTLIKE, baseUrl: `https://${HOSTLIKE}.vendor.invalid/x?y=${HOSTLIKE}`, policy: {} }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    for (const piece of pieces(HOSTLIKE)) expect(message, piece).not.toContain(piece);
  });

  it('names a network error code only from the fixed list', async () => {
    const gw = create(KEY, async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'VENDOR_DIAGNOSTIC' }) });
    });
    const result = await gw.callTool('stock_overview', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Der kunne ikke oprettes forbindelse til Bilinfo. Prøv igen om lidt.');
  });
});
