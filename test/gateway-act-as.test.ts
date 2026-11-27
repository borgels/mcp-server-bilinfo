// Act as a person (src/act-as.ts). The Listing API has no users, so a read is always made with the account's
// credentials. What every server guarantees still holds here: the host's verified person reaches a handler through
// the call scope, a refusal comes back as `actAsRefused` with a fixed text, a malformed person refuses the call
// before anything is sent, and the email is never sent to Bilinfo, written to the audit or put in a result.
import { describe, expect, it, vi } from 'vitest';
import { ActAsRefusedError, normaliseActAs } from '../src/act-as.js';
import { currentActAs } from '../src/bilinfo/policy.js';
import { createBilinfoGateway } from '../src/gateway.js';
import { exportBody, gatewayOptions, sampleStock } from './helpers.js';

const PASSWORD = 'Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU';
const EMAIL = 'Mette.Hansen@Fjordbybiler.example';

/** What the handlers throw instead of calling the API, as a server's handler does when it finds no user. */
const handler = vi.hoisted(() => ({ refuse: undefined as Error | undefined }));
vi.mock('../src/bilinfo/vehicles.js', async original => {
  const actual = await original<typeof import('../src/bilinfo/vehicles.js')>();
  return {
    ...actual,
    fetchVehicles: (...args: Parameters<typeof actual.fetchVehicles>) => {
      if (handler.refuse) return Promise.reject(handler.refuse);
      return actual.fetchVehicles(...args);
    },
  };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A gateway whose upstream records the person in scope at each request, and what was sent. */
function gateway(refuse?: ActAsRefusedError) {
  handler.refuse = refuse;
  const seen: Array<string | undefined> = [];
  const sent: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push(currentActAs()?.email);
    sent.push(`${String(input)} ${JSON.stringify(init?.headers ?? {})}`);
    return json(exportBody(sampleStock()));
  };
  const gw = createBilinfoGateway(
    gatewayOptions({ password: PASSWORD, fetchImpl, maxAttempts: 1, policy: { audit: record => void records.push({ ...record }) } }),
  );
  return { gw, seen, sent, records };
}

describe('normaliseActAs', () => {
  it('takes a verified email, lowercased and trimmed, with an optional name', () => {
    expect(normaliseActAs(undefined)).toBeUndefined();
    expect(normaliseActAs({ email: `  ${EMAIL} ` })).toEqual({ email: EMAIL.toLowerCase() });
    expect(normaliseActAs({ email: EMAIL, name: ' Mette Hansen ' })).toEqual({ email: EMAIL.toLowerCase(), name: 'Mette Hansen' });
  });

  it('refuses anything that is not one', () => {
    for (const value of [{ email: 'a..b@example.test' }, { email: '.a@example.test' }, { email: 'a.@example.test' }, { email: `${'a'.repeat(65)}@example.test` }, null, 'x@y.dk', { email: 'no-at-sign' }, { email: 'a\u0000b@example.test' }, { email: 'a b@example.test' }, { email: EMAIL, name: null }, { email: 'a@b' }, { email: 7 }, { email: EMAIL, name: '' }, { email: EMAIL, name: 'a\nb' }, [EMAIL]]) {
      expect(() => normaliseActAs(value), JSON.stringify(value)).toThrow(ActAsRefusedError);
    }
  });
});

describe('a gateway call with actAs', () => {
  it('gives the handler the person through the call scope, and only for that call', async () => {
    const { gw, seen } = gateway();
    expect((await gw.callTool('stock_overview', {}, { caller: 'p1', actAs: { email: EMAIL } })).isError).toBeUndefined();
    expect((await gw.callTool('stock_overview', {}, { caller: 'p1' })).isError).toBeUndefined();
    expect(seen).toEqual([EMAIL.toLowerCase(), undefined]);
  });

  it('reads with the credentials of the account and never sends the email to Bilinfo', async () => {
    const { gw, sent } = gateway();
    const result = await gw.callTool('list_vehicles', {}, { caller: 'p1', actAs: { email: EMAIL, name: 'Mette Hansen' } });
    expect(result.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.toLowerCase()).not.toContain('mette');
    expect(sent[0]!.toLowerCase()).not.toContain(EMAIL.toLowerCase());
    expect(JSON.stringify(result).toLowerCase()).not.toContain(EMAIL.toLowerCase());
  });

  it('answers a refusal from the handler with actAsRefused and a fixed text, never the email', async () => {
    for (const refusal of ['no_user', 'not_permitted'] as const) {
      const { gw } = gateway(new ActAsRefusedError(refusal));
      const result = await gw.callTool('stock_overview', {}, { caller: 'p1', actAs: { email: EMAIL } });
      expect(result.isError).toBe(true);
      expect(result.actAsRefused).toBe(refusal);
      expect(result.content[0]?.text).toMatch(/^Afvist: /);
      expect(JSON.stringify(result).toLowerCase()).not.toContain(EMAIL.toLowerCase());
    }
  });

  it('refuses a malformed person before anything is sent, null included', async () => {
    for (const actAs of [{ email: 'not an email' }, null, { email: 'a\u0000b@example.test' }]) {
      const { gw, seen } = gateway();
      const result = await gw.callTool('stock_overview', {}, { caller: 'p1', actAs: actAs as never });
      expect(result, JSON.stringify(actAs)).toMatchObject({ isError: true, actAsRefused: 'invalid' });
      expect(seen).toEqual([]);
    }
  });

  it('keeps the person of each call to that call when calls run at the same time', async () => {
    const { gw, seen } = gateway();
    await Promise.all([
      gw.callTool('stock_overview', {}, { actAs: { email: 'a@fjordbybiler.example' } }),
      gw.callTool('list_vehicles', {}, { actAs: { email: 'b@fjordbybiler.example' } }),
      gw.callTool('stock_overview', {}),
    ]);
    expect([...seen].sort()).toEqual(['a@fjordbybiler.example', 'b@fjordbybiler.example', undefined].sort());
  });

  it('never writes the email to the audit', async () => {
    const { gw, records } = gateway();
    await gw.callTool('stock_overview', {}, { caller: 'p1', actAs: { email: EMAIL } });
    await gw.callTool('list_vehicles', { make: 'Ford' }, { caller: 'p1', actAs: { email: EMAIL } });
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records).toLowerCase()).not.toContain(EMAIL.toLowerCase());
  });

  it('keeps actAsRefused only on an error result', async () => {
    const { gw } = gateway();
    const result = await gw.callTool('stock_overview', {}, { actAs: { email: EMAIL } });
    expect(result.isError).toBeUndefined();
    expect('actAsRefused' in result).toBe(false);
  });
});

describe('the refusal of a malformed person', () => {
  it('passes the same sink check as every other result, and a password that shares text with a field name is no problem', async () => {
    handler.refuse = undefined;
    // A password that shares a piece with the result's field name actAsRefused.
    const password = 'Zq7pactAsRK9mWb4TnR8yLc3Hd';
    const gw = createBilinfoGateway(gatewayOptions({ password, fetchImpl: async () => json({}), maxAttempts: 1 }));
    const result = await gw.callTool('stock_overview', {}, { actAs: null as never });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toContain(password);
    expect(result.actAsRefused).toBe('invalid');
  });

  it('keeps dotted addresses that are valid', () => {
    expect(normaliseActAs({ email: 'mette.k.hansen@fjordbybiler.example' })).toEqual({ email: 'mette.k.hansen@fjordbybiler.example' });
  });
});
