// One property, proved through every channel at once: no piece of an instance's secrets (six characters or more
// of the password, or of the encoded credentials that are sent) reaches a host result, a thrown error or an audit
// record. The password has a quote and a backslash, so a form that is serialised before it is redacted would show;
// the upstream echoes the secrets whole, in fragments, in keys, in error bodies and codes, in a redirect's Location
// and in an over-limit body; the environment holds the password where a number or a switch was expected.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basicCredentials } from '../src/bilinfo/client.js';
import { MAX_REDACT_DEPTH, redactDeep, SecretRedactor } from '../src/errors.js';
import { createBilinfoGateway, type GatewayToolResult } from '../src/gateway.js';
import { exportBody, exportRoutes, gateway, gatewayOptions, installTestWriteTool, listingId, USERNAME, vehicle } from './helpers.js';

const KEY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const FRAGMENT = KEY.slice(0, 12);
/** What is sent to Bilinfo: a secret of the instance like the password. */
const ENCODED = basicCredentials(USERNAME, KEY);
const originalEnv = { ...process.env };
let testWrite: ReturnType<typeof installTestWriteTool>;

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('BILINFO_')) delete process.env[name];
  }
  testWrite = installTestWriteTool();
});

afterEach(() => {
  testWrite.remove();
  process.env = { ...originalEnv };
});

/** Every string in a value, object keys included. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(entry => strings(entry, out));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      strings(entry, out);
    }
  }
  return out;
}

/** The secrets that are found anywhere in `value`, raw or serialised. */
function leaks(value: unknown): string[] {
  const texts = [...strings(value), JSON.stringify(value) ?? ''];
  return [KEY, ENCODED].filter(secret => texts.some(text => text.includes(secret)));
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A vehicle that echoes the secrets in values, in a key and nested. */
const echoing = vehicle(1, {
  Make: KEY,
  Model: FRAGMENT,
  Comment: `Kontakt os. ${ENCODED} ${KEY}`,
  [KEY]: 1,
  [`k ${FRAGMENT}`]: { deeper: [FRAGMENT, KEY, ENCODED] },
  DealerName: `Forhandler ${FRAGMENT}`,
});

type Channel = 'echo' | 'error' | 'unauthorised' | 'big-error' | 'big' | 'redirect' | 'network' | 'odd';

/** The upstream: the one request answers through the channel that is set. */
function upstreamOn(channel: { now: Channel }): typeof fetch {
  return async () => {
    switch (channel.now) {
      case 'echo':
        return json(exportBody([echoing, vehicle(2)]));
      case 'error':
        return json({ message: `Rejected ${KEY}`, code: FRAGMENT, details: { [KEY]: ENCODED } }, 400);
      case 'unauthorised':
        return json({ code: FRAGMENT, error: ENCODED }, 401, { 'www-authenticate': `Basic realm="${FRAGMENT}"` });
      case 'big-error':
        return new Response(`${' '.repeat(70_000)}${KEY}`, { status: 500, headers: { 'content-type': 'text/plain' } });
      case 'big':
        return new Response(`"${' '.repeat(30_000)}${KEY}"`, { status: 200, headers: { 'content-type': 'application/json' } });
      case 'redirect':
        return new Response(null, { status: 302, headers: { location: `https://elsewhere.test/${FRAGMENT}?k=${KEY}` } });
      case 'network':
        throw new TypeError(`fetch failed for ${KEY}`, { cause: Object.assign(new Error(`connect ${FRAGMENT}`), { code: FRAGMENT }) });
      default:
        // Not the documented list: refused with our own text, never passed on.
        return json({ Message: `no list for ${KEY}`, [ENCODED]: FRAGMENT });
    }
  };
}

describe('no piece of the secrets leaves an instance', () => {
  it('holds for every channel: results, errors and audit records', async () => {
    const records: unknown[] = [];
    const channel = { now: 'echo' as Channel };
    const gw = createBilinfoGateway(
      gatewayOptions({
        password: KEY,
        fetchImpl: upstreamOn(channel),
        maxAttempts: 1,
        maxResponseBytes: 20_000,
        policy: { enableWrites: true, audit: record => void records.push(record) },
      }),
    );
    const context = { caller: `caller ${KEY}`, requestId: FRAGMENT };
    const results: GatewayToolResult[] = [];
    for (const now of ['echo', 'error', 'unauthorised', 'big-error', 'big', 'redirect', 'network', 'odd'] as const) {
      channel.now = now;
      results.push(await gw.callTool('list_vehicles', now === 'echo' ? {} : { query: KEY }, context));
      results.push(await gw.callTool('get_vehicle', { vehicleId: listingId(1) }, context));
      results.push(await gw.callTool('stock_overview', {}, context));
    }
    results.push(await gw.callTool('test_write', { vehicleId: KEY, query: ENCODED }, context));
    results.push(await gw.callTool(`get_vehicle ${KEY}`, {}), await gw.callTool('get_vehicle', { vehicleId: KEY, [KEY]: FRAGMENT }));
    results.push(await gw.callTool('list_vehicles', { make: ENCODED, [ENCODED]: 1 }));

    // The first three answers are data: the list, the vehicle with every field, and the overview.
    expect(results.slice(0, 3).map(result => result.isError)).toEqual([undefined, undefined, undefined]);
    expect(JSON.stringify(results[1])).toContain('‹redacted›');
    expect(results.slice(3, 24).every(result => result.isError === true)).toBe(true);
    expect(records.length).toBeGreaterThan(10);
    expect(leaks(results)).toEqual([]);
    expect(leaks(records)).toEqual([]);
  });

  it('holds for errors about the environment, with or without an instance', async () => {
    const answers: unknown[] = [];
    for (const name of ['BILINFO_ENABLE_WRITES', 'BILINFO_DISABLED_TOOLS', 'BILINFO_TIMEOUT_MS', 'BILINFO_MAX_CONCURRENCY', 'BILINFO_MAX_RESPONSE_BYTES']) {
      process.env[name] = KEY;
      try {
        // Without a host policy the environment applies: the bad value fails at creation or at the call.
        const gw = createBilinfoGateway(gatewayOptions({ password: KEY, fetchImpl: upstreamOn({ now: 'echo' }) }));
        answers.push(await gw.callTool('test_write', {}));
      } catch (error) {
        answers.push((error as Error).message);
      }
      delete process.env[name];
    }
    expect(answers.filter(answer => typeof answer === 'string' || (answer as GatewayToolResult).isError)).toHaveLength(5);
    expect(leaks(answers)).toEqual([]);
  });
});

describe('redactDeep', () => {
  it('replaces anything deeper than its limit, strings at the limit included, and redacts what is above it', () => {
    const redactor = new SecretRedactor().addSecret(KEY);
    let value: unknown = KEY;
    for (let i = 0; i < MAX_REDACT_DEPTH; i += 1) value = [value];
    // The string sits at depth MAX_REDACT_DEPTH: redacted, not replaced.
    expect(JSON.stringify(redactDeep(value, redactor))).toContain('‹redacted›');
    expect(JSON.stringify(redactDeep([value], redactor))).toContain('[nested too deep]');
    expect(leaks(redactDeep([value], redactor))).toEqual([]);
  });
});

describe('the data in the text block', () => {
  it('carries the redacted structured content as compact JSON after the summary', async () => {
    const gw = createBilinfoGateway(gatewayOptions({ password: KEY, fetchImpl: upstreamOn({ now: 'echo' }), maxAttempts: 1 }));
    const result = await gw.callTool('get_vehicle', { vehicleId: listingId(1) });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const [summary, data, ...rest] = result.content[0]!.text.split('\n\n');
    expect(summary).not.toBe('');
    expect(summary).not.toContain('{');
    expect(rest).toEqual([]);
    expect(data).toBe(JSON.stringify(result.structuredContent));
    expect(data).not.toContain('\n');
    expect(data).toContain('‹redacted›');
    expect(leaks(result)).toEqual([]);
  });

  it('gives a client that reads only the text the data', async () => {
    const { gw } = gateway(exportRoutes([vehicle(7, { Variant: 'Testbil Blå' })]));
    const result = await gw.callTool('list_vehicles', {});
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]!.text).toContain('"variant":"Testbil Blå"');
    expect(result.content[0]!.text.endsWith(JSON.stringify(result.structuredContent))).toBe(true);
  });

  it('leaves error results with their text only', async () => {
    const gw = createBilinfoGateway(gatewayOptions({ password: KEY, fetchImpl: upstreamOn({ now: 'error' }), maxAttempts: 1 }));
    const result = await gw.callTool('stock_overview', {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]!.text).not.toContain('\n\n{');
  });
});
