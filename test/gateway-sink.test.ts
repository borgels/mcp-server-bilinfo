// The sink check (README, "Threat model"): no password is refused for its form, and no answer or audit record that
// leaves a gateway holds the password or the encoded credentials, when they can be told from ordinary text.
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basicCredentials } from '../src/bilinfo/client.js';
import { createBilinfoGateway } from '../src/gateway.js';
import { visibleTexts } from '../src/secrets.js';
import { UNEXPECTED_ANSWER } from '../src/bilinfo/vehicles.js';
import { exportBody, gatewayOptions, installTestWriteTool, listingId, sampleStock, USERNAME, vehicle } from './helpers.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A vendor-like value that our texts do not share. */
const PLAIN = 'Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU';

let testWrite: ReturnType<typeof installTestWriteTool>;
beforeEach(() => {
  testWrite = installTestWriteTool();
});
afterEach(() => {
  testWrite.remove();
});

/** The secrets of an instance with this password: the password, and the encoded credentials. */
function secretsOf(password: string): string[] {
  return [password, basicCredentials(USERNAME, password)];
}

/** The whole secrets found in any text a host or a log could see. */
function leaked(password: string, outputs: unknown[]): string[] {
  const texts = outputs.flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)));
  return secretsOf(password).filter(secret => texts.some(text => text.includes(secret)));
}

const upstream: typeof fetch = async () => json(exportBody(sampleStock()));

/**
 * Every answer and audit record of a normal session with this password. The tool list is left out: it is a fixed
 * text of ours, the same for every instance. Creating the gateway must not throw, whatever the password is.
 */
async function outputs(password: string): Promise<unknown[]> {
  const records: unknown[] = [];
  const gw = createBilinfoGateway(
    gatewayOptions({
      password,
      fetchImpl: upstream,
      maxAttempts: 1,
      policy: { enableWrites: true, audit: record => void records.push(record) },
    }),
  );
  const results = [
    await gw.callTool('list_vehicles', { make: 'Skoda' }, { caller: 'person-1', requestId: 'r1' }),
    await gw.callTool('list_vehicles', {}, { caller: `person ${password}`, requestId: password }),
    await gw.callTool('get_vehicle', { vehicleId: listingId(1) }, { caller: 'person-1', requestId: 'r2' }),
    await gw.callTool('stock_overview', {}),
    await gw.callTool('test_write', { vehicleId: 'x' }, { caller: 'person-1', requestId: 'r3' }),
    await gw.callTool('get_vehicle', { vehicleId: listingId(99) }),
    await gw.callTool(`no_such_tool ${password}`, {}),
    await gw.callTool('list_vehicles', { [password]: 1 }),
  ];
  return [...results, ...records];
}

describe('the sink check', () => {
  it('accepts whatever password Bilinfo could issue and keeps the whole of it out of every answer and record', async () => {
    for (const password of [
      PLAIN,
      'med mellemrum 1234',
      ' kode med mellemrum for og bag ',
      'blåbærgrød-1234',
      'Zq7pX2vK9mWb4TnRé',
      'riskLevelQz7pX2vK9mWb',
      'qz7":"staV8k2mP9',
      'x"ok":y-0123456789',
      'Biler til salg 2026',
      'Bilinfo2026',
      'Adgangskoden-9471',
      'URI malformedQz7pX2vK9mWb\uD800',
      '‹redacted›-Zq7pX2vK9mWb',
    ]) {
      const seen = await outputs(password);
      expect(leaked(password, seen), password).toEqual([]);
      // The password was put into the caller, the request id, a tool name and a field name: it was redacted there.
      expect(JSON.stringify(seen), password).toContain('‹redacted›');
    }
  });

  it('leaves ordinary words alone: a password that holds a car make does not blank the make out of the answers', async () => {
    for (const password of ['Skoda-2026', 'Skoda i Fjordby', 'Sommer2026!']) {
      const seen = await outputs(password);
      expect(leaked(password, seen), password).toEqual([]);
      const first = seen[0] as { isError?: boolean; structuredContent: { vehicles: Array<{ make: string }> } };
      expect(first.isError, password).toBeUndefined();
      expect(first.structuredContent.vehicles.length, password).toBeGreaterThan(0);
      for (const vehicle of first.structuredContent.vehicles) expect(vehicle.make, password).toBe('Skoda');
    }
  });

  it('redacts a password that stands whole in the data, and passes the rest of the answer on', async () => {
    const password = 'Skoda Octavia';
    const gw = createBilinfoGateway(
      gatewayOptions({
        password,
        fetchImpl: async () => json(exportBody([vehicle(1, { Make: 'Skoda', Model: 'Octavia', Comment: `Pæn ${password} med træk` })])),
      }),
    );
    const result = await gw.callTool('get_vehicle', { vehicleId: listingId(1) });
    expect(result.isError).toBeUndefined();
    expect(leaked(password, [result])).toEqual([]);
    const text = JSON.stringify(result);
    expect(text).toContain('Pæn ‹redacted› med træk');
    expect(text).toContain('"Model":"Octavia"');
  });

  it('does not look for a password that cannot be told from ordinary text: a short one, or a word of our own texts', async () => {
    for (const password of ['k', 'kort', 'Skoda', 'Bilinfo', 'forhandlerens', 'Ukendt værktøj']) {
      const records: unknown[] = [];
      const gw = createBilinfoGateway(
        gatewayOptions({ password, fetchImpl: upstream, policy: { audit: record => void records.push(record) } }),
      );
      const seen = [
        await gw.callTool('list_vehicles', { make: 'Skoda' }),
        await gw.callTool('stock_overview', {}),
        await gw.callTool('no_such_tool', {}),
        ...records,
      ];
      expect(JSON.stringify(seen), password).not.toContain('‹redacted›');
      expect((seen[0] as { isError?: boolean }).isError, password).toBeUndefined();
    }
  });

  it('sends the password to Bilinfo exactly as it was given', async () => {
    for (const password of [' kode med mellemrum for og bag ', 'blåbærgrød', 'k', 'a:b:c']) {
      let sent = '';
      const gw = createBilinfoGateway(
        gatewayOptions({
          password,
          fetchImpl: async (_url, init) => {
            sent = (init?.headers as Record<string, string>).Authorization ?? '';
            return json(exportBody(sampleStock()));
          },
        }),
      );
      expect((await gw.callTool('stock_overview', {})).isError, password).toBeUndefined();
      expect(sent, password).toBe(`Basic ${Buffer.from(`${USERNAME}:${password}`, 'utf8').toString('base64')}`);
    }
  });
});

describe('answers in another form', () => {
  it('passes on only the documented list: any other successful answer is refused with our own text', async () => {
    for (const body of [
      { data: { failures: ['Vendor diagnostic'], errors: ['Vendor diagnostic'] } },
      { Message: 'Vendor diagnostic' },
      { Vehicles: 'Vendor diagnostic' },
      ['Vendor diagnostic'],
    ]) {
      const gw = createBilinfoGateway(gatewayOptions({ password: PLAIN, maxAttempts: 1, fetchImpl: async () => json(body) }));
      for (const result of [
        await gw.callTool('list_vehicles', {}),
        await gw.callTool('get_vehicle', { vehicleId: listingId(1) }),
        await gw.callTool('stock_overview', {}),
      ]) {
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe(UNEXPECTED_ANSWER);
        expect(JSON.stringify(result)).not.toContain('Vendor');
      }
    }
  });
});

describe('construction errors', () => {
  it('are thrown in final form: no frames or paths in the stack, no cause', () => {
    for (const [password, baseUrl] of [
      ['scratchpadQz7pX2vK9mWb', ''],
      ['scratchpadQz7pX2vK9mWb', 'bad'],
      ['Zq7pX2-node:i-Wb4TnR', 'bad'],
      ['short', 'bad'],
    ] as const) {
      let caught: Error | undefined;
      try {
        createBilinfoGateway(gatewayOptions({ password, baseUrl }));
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, password).toBeInstanceOf(Error);
      const stack = String(caught!.stack);
      expect(stack).toBe(`${caught!.name}: ${caught!.message}`);
      expect(stack).not.toMatch(/\n\s+at /);
      expect((caught as { cause?: unknown }).cause).toBeUndefined();
      expect(leaked(password, [stack, caught!.message, caught!.name, caught])).toEqual([]);
    }
  });

  it('never quote the user name or the password, whatever is wrong with them', () => {
    for (const [username, password] of [
      ['fjordby:test', PLAIN],
      ['', PLAIN],
    ] as const) {
      let message = '';
      try {
        createBilinfoGateway(gatewayOptions({ username, password }));
      } catch (error) {
        message = String((error as Error).stack);
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('fjordby');
      expect(leaked(password, [message])).toEqual([]);
    }
  });
});

describe('addresses', () => {
  it('quotes no configured address in network, timeout or redirect errors', async () => {
    const ADDRESS = 'https://api.vendor-name.invalid/listingapi';
    for (const fetchImpl of [
      async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
      },
      async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/' } }),
    ] as Array<typeof fetch>) {
      const gw = createBilinfoGateway(gatewayOptions({ password: PLAIN, baseUrl: ADDRESS, allowCustomBaseUrl: true, maxAttempts: 1, fetchImpl }));
      const result = await gw.callTool('stock_overview', {});
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('vendor-name');
      expect(JSON.stringify(result)).not.toContain('elsewhere');
    }
  });
});
