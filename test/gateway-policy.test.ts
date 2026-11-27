import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBilinfoGateway } from '../src/gateway.js';
import { exportRoutes, gatewayOptions, installTestWriteTool, sampleStock, stubFetch, texts } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;
let testWrite: ReturnType<typeof installTestWriteTool>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bilinfo-policy-'));
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
  rmSync(dir, { recursive: true, force: true });
});

const PASSWORD = `tenant-${'x'.repeat(12)}`;

function routes() {
  return stubFetch(exportRoutes(sampleStock()));
}

function create(extra: Parameters<typeof gatewayOptions>[0] = {}) {
  return createBilinfoGateway(gatewayOptions({ password: PASSWORD, fetchImpl: routes() as unknown as typeof fetch, ...extra }));
}

/** Records every environment variable read while `work` runs. */
async function envReads(work: () => Promise<void>): Promise<Set<string>> {
  const reads = new Set<string>();
  const env = { ...process.env };
  process.env = new Proxy(env, {
    get(target, property, receiver) {
      if (typeof property === 'string') {
        reads.add(property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await work();
  } finally {
    process.env = env;
  }
  return reads;
}

describe('instance policy from the host', () => {
  it('reads no policy, audit or credential variable from the environment', async () => {
    process.env.BILINFO_ENABLE_WRITES = 'true';
    process.env.BILINFO_DISABLED_TOOLS = 'stock_overview';
    process.env.BILINFO_AUDIT_LOG = join(dir, 'audit.jsonl');
    process.env.BILINFO_ALLOW_CUSTOM_BASE_URL = 'true';
    process.env.BILINFO_USERNAME = 'someone-else';
    process.env.BILINFO_PASSWORD = 'someone-elses-password';
    process.env.BILINFO_DEALER_ID = '0f0f0f0f-aaaa-4bbb-8ccc-00000000000f';
    process.env.BILINFO_BASE_URL = 'https://elsewhere.bilinfo.net/listingapi';

    const fetchImpl = routes();
    const reads = await envReads(async () => {
      const gw = create({ fetchImpl: fetchImpl as unknown as typeof fetch, policy: {} });
      expect(gw.tools.map(tool => tool.name)).toContain('stock_overview');
      const read = await gw.callTool('stock_overview', {});
      expect(read.isError).toBeUndefined();
      const write = await gw.callTool('test_write', {});
      expect(write.isError).toBe(true);
      expect(texts(write).join(' ')).toMatch(/Det styres af den, der har sat forbindelsen op/);
    });

    for (const name of [
      'BILINFO_ENABLE_WRITES',
      'BILINFO_DISABLED_TOOLS',
      'BILINFO_AUDIT_LOG',
      'BILINFO_ALLOW_CUSTOM_BASE_URL',
      'BILINFO_USERNAME',
      'BILINFO_PASSWORD',
      'BILINFO_DEALER_ID',
      'BILINFO_BASE_URL',
    ]) {
      expect(reads.has(name), name).toBe(false);
    }
    expect(existsSync(join(dir, 'audit.jsonl'))).toBe(false);
    expect(testWrite.runs).toEqual([]);
    // The request went to the instance's own address, without the dealer of the environment.
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toMatch(/elsewhere|dealerId/);
  });

  it('keeps two instances in one process apart', async () => {
    const a = create({ policy: { disabledTools: ['stock_overview'] } });
    const b = create({ policy: { enableWrites: true } });

    expect(a.tools.map(tool => tool.name)).not.toContain('stock_overview');
    expect(b.tools.map(tool => tool.name)).toContain('stock_overview');

    const [denied, allowed] = await Promise.all([a.callTool('stock_overview', {}), b.callTool('test_write', {})]);
    expect(denied.isError).toBe(true);
    expect(texts(denied).join(' ')).toMatch(/Værktøjet er slået fra af den, der har sat forbindelsen op/);
    expect(allowed.isError).toBeUndefined();
    expect(testWrite.runs).toHaveLength(1);
  });

  it('sends audit records to the host and refuses a write whose start record is refused', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = create({ policy: { enableWrites: true, audit: record => void records.push({ ...record }) } });
    await gw.callTool('stock_overview', {}, { requestId: 'r1', caller: 'person-1' });
    expect(records.map(r => [r.requestId, r.action, r.caller])).toEqual([
      ['r1', 'start', 'person-1'],
      ['r1', 'finish', 'person-1'],
    ]);

    const refusing = create({
      policy: {
        enableWrites: true,
        audit: () => {
          throw new Error('sink down');
        },
      },
    });
    const write = await refusing.callTool('test_write', {});
    expect(write.isError).toBe(true);
    expect(testWrite.runs).toEqual([]);
  });

  it('rejects an unclear policy when the instance is created', () => {
    const withPolicy = (policy: unknown) => () => create({ policy: policy as never });
    expect(withPolicy({ disabledTools: ['no_such_tool'] })).toThrow(/is not a known tool/);
    expect(withPolicy({ enableWrites: 'yes' })).toThrow(/enableWrites/);
    expect(withPolicy({ audit: 'file.jsonl' })).toThrow(/audit/);
    expect(withPolicy(null)).toThrow(/policy/);
  });

  it('still uses the environment without a host policy', async () => {
    const before = await create().callTool('test_write', {});
    expect(before.isError).toBe(true);
    expect(texts(before).join(' ')).toMatch(/BILINFO_ENABLE_WRITES/);

    process.env.BILINFO_ENABLE_WRITES = 'true';
    const write = await create().callTool('test_write', {});
    expect(write.isError).toBeUndefined();
    expect(testWrite.runs).toHaveLength(1);
  });
});
