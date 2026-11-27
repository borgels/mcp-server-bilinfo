import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basicCredentials, CREDENTIAL_HEADER } from '../src/bilinfo/client.js';
import { createBilinfoGateway } from '../src/gateway.js';
import { exportBody, exportRoutes, gatewayOptions, installTestWriteTool, sampleStock, stubFetch, texts, USERNAME } from './helpers.js';

// Every gateway call runs in a call scope of its own: its policy (or the environment), its sink and its
// redactor, also when it is made from inside another instance's call, and also across await.

const originalEnv = { ...process.env };
let testWrite: ReturnType<typeof installTestWriteTool>;

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('BILINFO_')) {
      delete process.env[name];
    }
  }
  testWrite = installTestWriteTool();
});

afterEach(() => {
  testWrite.remove();
  process.env = { ...originalEnv };
});

type AuditRecord = Record<string, unknown>;

const KEY_A = `tenant-a-${'a'.repeat(12)}`;
const KEY_B = `tenant-b-${'b'.repeat(12)}`;
// Longer than every cut the audit makes (64 for field names, 100 for tool names, 200 for reasons), so a
// password that was cut before it was redacted would show.
const LONG_KEY = `long-${'k'.repeat(250)}`;

function routes() {
  return stubFetch(exportRoutes(sampleStock()));
}

function create(password: string, extra: Parameters<typeof gatewayOptions>[0] = {}) {
  return createBilinfoGateway(gatewayOptions({ password, fetchImpl: routes() as unknown as typeof fetch, ...extra }));
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A fetch whose answers wait until `release` is called, recording the credentials each request carried. */
function heldFetch() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let signalStarted!: () => void;
  /** Resolves when the first request has reached the stand-in and is waiting. */
  const started = new Promise<void>(resolve => {
    signalStarted = resolve;
  });
  const credentials: string[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    credentials.push(String((init?.headers as Record<string, string> | undefined)?.[CREDENTIAL_HEADER] ?? ''));
    signalStarted();
    await gate;
    return json(exportBody(sampleStock()));
  }) as unknown as typeof fetch;
  return { fetchImpl, release, started, credentials };
}

describe('admission of the password', () => {
  it('refuses no password for its form: short, with spaces, with æ, ø and å, or with words of our own texts', () => {
    for (const password of [
      'k',
      'abc123',
      '1234567',
      'Xk9#mQ2',
      'med mellemrum 1234',
      ' mellemrum for og bag ',
      'blåbærgrød-1234',
      'Adgangskoden-9471',
      'Bilinfo2026',
      'Biler til salg (Bilinfo)',
    ]) {
      for (const policy of [{}, undefined]) {
        expect(() => create(password, policy ? { policy } : {}), password).not.toThrow();
      }
    }
  });

  it('requires both parts of a pair, at least one pair, and never reads them from the environment', () => {
    process.env.BILINFO_USERNAME = 'someone-else';
    process.env.BILINFO_PASSWORD = 'someone-elses-password';
    process.env.BILINFO_CLIENT_ID = 'someone-elses-client';
    process.env.BILINFO_CLIENT_SECRET = 'someone-elses-secret';
    try {
      expect(() => createBilinfoGateway(gatewayOptions({ username: '' }))).toThrow('options.username');
      expect(() => createBilinfoGateway(gatewayOptions({ password: undefined as never }))).toThrow('options.password');
      expect(() => createBilinfoGateway(gatewayOptions({ clientId: 'klient-1' }))).toThrow('options.clientSecret');
      expect(() => createBilinfoGateway({ policy: {} })).toThrow('options.username and options.password');
      expect(() => createBilinfoGateway(gatewayOptions({ dealerId: 'not-a-guid' }))).toThrow('GUID');
      expect(() => createBilinfoGateway(gatewayOptions({ username: 'a:b' }))).toThrow('colon');
      // Either pair is enough.
      expect(() => createBilinfoGateway({ clientId: 'klient-1', clientSecret: 'hemmelig', policy: {} })).not.toThrow();
    } finally {
      delete process.env.BILINFO_CLIENT_ID;
      delete process.env.BILINFO_CLIENT_SECRET;
    }
  });
});

describe('audit records', () => {
  it('keep the instance password out, refusals, input and metadata included', async () => {
    const records: AuditRecord[] = [];
    const gw = create(LONG_KEY, { policy: { audit: record => void records.push(record) } });
    const metadata = { caller: `person ${LONG_KEY}`, requestId: LONG_KEY };
    await gw.callTool(LONG_KEY, {}, metadata);
    await gw.callTool(`get_${LONG_KEY}`, {}, metadata);
    await gw.callTool('list_vehicles', { [LONG_KEY]: 'x', make: 'Ford' }, metadata);
    await gw.callTool('get_vehicle', { vehicleId: LONG_KEY }, metadata);
    await gw.callTool('list_vehicles', { make: 'Ford' }, metadata);
    await gw.callTool('test_write', { vehicleId: LONG_KEY, query: LONG_KEY }, metadata);

    expect(records.length).toBeGreaterThanOrEqual(6);
    const text = JSON.stringify(records);
    expect(text).not.toContain(LONG_KEY);
    // Not even a part of it.
    expect(text).not.toContain('k'.repeat(40));
    expect(text).toContain('‹redacted›');
  });
});

describe('call scopes', () => {
  it('isolate two allowed calls with different credentials and sinks across await', async () => {
    const held = heldFetch();
    const sinkA: AuditRecord[] = [];
    const sinkB: AuditRecord[] = [];
    const a = create(KEY_A, { fetchImpl: held.fetchImpl, policy: { audit: r => void sinkA.push(r) } });
    const b = create(KEY_B, { policy: { enableWrites: true, audit: r => void sinkB.push(r) } });

    // A starts and waits inside its upstream request; B runs a read and a write meanwhile; then A resumes.
    const pendingA = a.callTool('stock_overview', {}, { requestId: 'a' });
    await held.started;
    expect(held.credentials).toEqual([`Basic ${basicCredentials(USERNAME, KEY_A)}`]);
    expect((await b.callTool('stock_overview', {}, { requestId: 'b1' })).isError).toBeUndefined();
    expect((await b.callTool('test_write', {}, { requestId: 'b2' })).isError).toBeUndefined();
    held.release();
    expect((await pendingA).isError).toBeUndefined();
    // After resuming, A still cannot write: its own policy, not B's.
    expect((await a.callTool('test_write', {}, { requestId: 'a2' })).isError).toBe(true);
    expect(testWrite.runs).toHaveLength(1);

    expect(sinkA.filter(r => r.requestId === 'a').map(r => r.action)).toEqual(['start', 'finish']);
    expect(new Set(sinkA.map(r => r.requestId))).toEqual(new Set(['a', 'a2']));
    expect(new Set(sinkB.map(r => r.requestId))).toEqual(new Set(['b1', 'b2']));
  });

  it('do not let a call from inside another instance inherit its policy or sink', async () => {
    // A allows writes and audits to its sink. From inside A's sink, B (no host policy; the environment
    // allows no writes) tries a write: refused, nothing run, and nothing of B's in A's sink.
    const sinkA: AuditRecord[] = [];
    const b = create(KEY_B);
    const nested: Array<Promise<{ isError?: boolean; content: Array<{ text: string }> }>> = [];
    const a = create(KEY_A, {
      policy: {
        enableWrites: true,
        audit: record => {
          sinkA.push(record);
          if (record.action === 'start' && nested.length === 0) {
            nested.push(b.callTool('test_write', { vehicleId: 'from-b' }, { requestId: 'b' }));
          }
        },
      },
    });
    expect((await a.callTool('test_write', { vehicleId: 'from-a' }, { requestId: 'a' })).isError).toBeUndefined();
    const fromInside = await nested[0]!;
    expect(fromInside.isError).toBe(true);
    expect(texts(fromInside).join(' ')).toMatch(/BILINFO_ENABLE_WRITES/);
    expect(testWrite.runs).toEqual([{ vehicleId: 'from-a' }]);
    expect(sinkA.every(r => r.requestId === 'a')).toBe(true);
  });

  it('do not let an instance with a policy, called from inside one without, use the environment', async () => {
    // A has no host policy and the environment allows writes. From inside A's upstream request, B (host
    // policy without writes) tries a write: refused. After B returns, A's own write still goes through.
    process.env.BILINFO_ENABLE_WRITES = 'true';
    const b = create(KEY_B, { policy: {} });
    let fromInside: { isError?: boolean } | undefined;
    const fetchA = (async () => {
      fromInside = await b.callTool('test_write', { vehicleId: 'from-b' });
      return json(exportBody(sampleStock()));
    }) as unknown as typeof fetch;
    const a = create(KEY_A, { fetchImpl: fetchA });
    expect((await a.callTool('stock_overview', {})).isError).toBeUndefined();
    expect(fromInside?.isError).toBe(true);
    expect((await a.callTool('test_write', { vehicleId: 'from-a' })).isError).toBeUndefined();
    expect(testWrite.runs).toEqual([{ vehicleId: 'from-a' }]);
  });

  it('validate a gateway created inside another instance against the environment, not against its policy', async () => {
    // A's policy disables nothing unknown; the environment names a tool that does not exist. A gateway without a host
    // policy, created inside A's sink or fetch, must fail on the environment as it would anywhere else.
    process.env.BILINFO_DISABLED_TOOLS = 'no_such_tool';
    const created: Array<{ where: string; error: unknown }> = [];
    const tryCreate = (where: string) => {
      try {
        create(KEY_B);
        created.push({ where, error: undefined });
      } catch (error) {
        created.push({ where, error });
      }
    };
    const fetchA = (async () => {
      tryCreate('fetch');
      return json(exportBody(sampleStock()));
    }) as unknown as typeof fetch;
    const a = create(KEY_A, {
      fetchImpl: fetchA,
      policy: {
        audit: record => {
          if (record.action === 'start') tryCreate('sink');
        },
      },
    });
    expect((await a.callTool('stock_overview', {})).isError).toBeUndefined();
    expect(created.map(c => c.where).sort()).toEqual(['fetch', 'sink']);
    for (const c of created) {
      expect(String(c.error), c.where).toMatch(/BILINFO_DISABLED_TOOLS names 1 unknown tool/);
    }
  });

  it('never run a write when the start record is refused', async () => {
    const gw = create(KEY_A, {
      policy: {
        enableWrites: true,
        audit: record => {
          if (record.action === 'start') throw new Error('sink down');
        },
      },
    });
    expect((await gw.callTool('stock_overview', {})).isError).toBeUndefined();
    const write = await gw.callTool('test_write', {});
    expect(write.isError).toBe(true);
    expect(testWrite.runs).toEqual([]);
  });

  it('name the one who set the connection up, not an environment variable, when a host policy refuses', async () => {
    const gw = create(KEY_A, { policy: { disabledTools: ['stock_overview'] } });
    const disabled = texts(await gw.callTool('stock_overview', {})).join(' ');
    const write = texts(await gw.callTool('test_write', {})).join(' ');
    for (const text of [disabled, write]) {
      expect(text).not.toMatch(/BILINFO_/);
      expect(text).toMatch(/den, der har sat forbindelsen op/);
    }
  });
});
