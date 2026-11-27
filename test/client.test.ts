import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { basicCredentials, BilinfoClient, CREDENTIAL_HEADER, DEFAULT_BASE_URL, readOnlyClient } from '../src/bilinfo/client.js';
import { BilinfoHttpError, parseRetryAfterMs, redactSecrets, SecretRedactor } from '../src/errors.js';
import { USER_AGENT } from '../src/version.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const BASE = 'https://listing.bilinfo.test/listingapi';
const DEALER = '0f0f0f0f-aaaa-4bbb-8ccc-000000000001';

type Handler = (url: string, init?: RequestInit) => Response | unknown | Promise<Response | unknown>;

function makeFetch(handler: Handler) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const result = await handler(String(input), init);
    if (result instanceof Response) {
      return result;
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

const noSleep = vi.fn(async (_ms: number) => undefined);

type Options = ConstructorParameters<typeof BilinfoClient>[0];

/** Options for a client on the test host; `credentialEnv: {}` keeps the developer's own environment out. */
function options(extra: Partial<NonNullable<Options>> = {}): NonNullable<Options> {
  return { username: 'u', password: 'p', baseUrl: BASE, allowCustomBaseUrl: true, credentialEnv: {}, ...extra };
}

function makeClient(fetchImpl: typeof fetch, extra: Partial<NonNullable<Options>> = {}) {
  return new BilinfoClient(options({ fetchImpl, sleep: noSleep, ...extra }));
}

describe('BilinfoClient', () => {
  it('sends the credentials as HTTP Basic with the User-Agent and never follows redirects', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = makeFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return { Vehicles: [] };
    });

    await makeClient(fetchImpl, { username: 'fjordby-test', password: 'secret-password', baseUrl: `${BASE}/` }).get('/api/export', {
      dealerId: DEALER,
    });

    expect(seenUrl).toBe(`${BASE}/api/export?dealerId=${DEALER}`);
    const expected = Buffer.from('fjordby-test:secret-password', 'utf8').toString('base64');
    expect(headersOf(seenInit)[CREDENTIAL_HEADER]).toBe(`Basic ${expected}`);
    expect(headersOf(seenInit)['User-Agent']).toBe(USER_AGENT);
    expect(headersOf(seenInit).Accept).toBe('application/json');
    expect(seenInit?.method).toBe('GET');
    expect(seenInit?.body).toBeUndefined();
    expect(seenInit?.redirect).toBe('manual');
    // The credentials travel in the header only.
    expect(seenUrl).not.toContain('secret-password');
    expect(seenUrl).not.toContain(expected);
  });

  it('hands read tools a view that cannot send a change, and has no method for anything this server does not do', async () => {
    const fetchImpl = makeFetch(() => ({}));
    const client = makeClient(fetchImpl);
    const view = readOnlyClient(client, 'bilinfo_list_vehicles');
    await expect(view.put('/x', {}, { service: 'leads', scope: 'scope' })).rejects.toThrow('refused');
    await expect(view.post('/x', {}, { service: 'cars', scope: 'scope' })).rejects.toThrow('refused');
    expect(fetchImpl).not.toHaveBeenCalled();
    for (const method of ['patch', 'delete']) {
      expect((client as unknown as Record<string, unknown>)[method], method).toBeUndefined();
    }
  });

  it('uses the Listing API address when no base URL is given, and reads the environment otherwise', async () => {
    const fetchImpl = makeFetch(() => ({ Vehicles: [] }));
    const fixed = new BilinfoClient({ username: 'u', password: 'p', credentialEnv: {}, fetchImpl });
    expect(fixed.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_BASE_URL).toBe('https://gw.bilinfo.net/listingapi');

    process.env.BILINFO_USERNAME = 'env-user';
    process.env.BILINFO_PASSWORD = 'env-password';
    process.env.BILINFO_DEALER_ID = DEALER.toUpperCase();
    process.env.BILINFO_BASE_URL = 'http://127.0.0.1:1/listingapi';
    let seenInit: RequestInit | undefined;
    const fromEnv = new BilinfoClient({
      fetchImpl: makeFetch((_url, init) => {
        seenInit = init;
        return {};
      }),
    });
    expect(fromEnv.baseUrl).toBe('http://127.0.0.1:1/listingapi');
    expect(fromEnv.dealerId).toBe(DEALER);
    await fromEnv.get('/api/export');
    expect(headersOf(seenInit)[CREDENTIAL_HEADER]).toBe(`Basic ${basicCredentials('env-user', 'env-password')}`);
  });

  it('throws before sending anything when the user name or the password is missing', async () => {
    const fetchImpl = makeFetch(() => ({}));
    for (const missing of [{ username: undefined }, { password: undefined }]) {
      const error = (await makeClient(fetchImpl, missing)
        .get('/api/export')
        .catch((e: unknown) => e)) as Error;
      expect(error.message).toContain('BILINFO_USERNAME');
      expect(error.message).toContain('BILINFO_PASSWORD');
      expect(error.message).toMatch(/mangler/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a user name that cannot be sent as HTTP Basic, and a dealer id that is not a GUID, without quoting them', () => {
    expect(() => basicCredentials('a:b', 'pw')).toThrow('colon');
    // Whatever Bilinfo issues is sent as it is: short, with spaces, with æ, ø and å, with a colon in the secret.
    for (const secret of ['pw', 'to ord', ' kode ', 'kodeæøå', 'a:b', 'Bilinfo2026']) {
      expect(basicCredentials('bruger', secret), secret).toBe(Buffer.from(`bruger:${secret}`, 'utf8').toString('base64'));
    }

    let message = '';
    try {
      new BilinfoClient(options({ dealerId: 'forhandler-17' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('GUID');
    expect(message).not.toContain('forhandler-17');
    expect(new BilinfoClient(options({ dealerId: ` ${DEALER.toUpperCase()} ` })).dealerId).toBe(DEALER);
  });

  it('refuses unsafe base URLs without echoing credentials', () => {
    const at = (baseUrl: string, allowCustomBaseUrl = false) => () => new BilinfoClient(options({ baseUrl, allowCustomBaseUrl }));
    expect(at('http://gw.bilinfo.net/listingapi')).toThrow('https://');
    expect(at('not a url')).toThrow('not a valid URL');
    expect(at('http://127.0.0.1:8080/api')).not.toThrow();
    expect(at('http://localhost:8080/api')).not.toThrow();
    expect(at('http://[::1]:8080/api')).not.toThrow();

    // Only Bilinfo's own hosts get the credentials, unless the operator says otherwise.
    expect(at('https://gw.bilinfo.net/listingapi')).not.toThrow();
    expect(at('https://bilinfo.net/listingapi')).not.toThrow();
    expect(at('https://gw.bilinfo.net.other.test/listingapi')).toThrow('bilinfo.net');
    expect(at('https://notbilinfo.net/listingapi')).toThrow('bilinfo.net');
    expect(at('https://other.test/listingapi', true)).not.toThrow();

    for (const baseUrl of [
      'https://user:hunter2@gw.bilinfo.net/listingapi',
      'https://gw.bilinfo.net/listingapi?x=1',
      'https://gw.bilinfo.net/listingapi#frag',
    ]) {
      let message = '';
      try {
        new BilinfoClient(options({ baseUrl }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('credentials, a query string or a fragment');
      expect(message).not.toContain('hunter2');
    }
  });

  it('validates numeric environment variables and options instead of producing NaN', () => {
    const fromEnv = () => new BilinfoClient({ username: 'u', password: 'p' });
    process.env.BILINFO_TIMEOUT_MS = '30s';
    expect(fromEnv).toThrow('BILINFO_TIMEOUT_MS');
    process.env.BILINFO_TIMEOUT_MS = '3000000000';
    expect(fromEnv).toThrow('BILINFO_TIMEOUT_MS');
    delete process.env.BILINFO_TIMEOUT_MS;
    process.env.BILINFO_MAX_CONCURRENCY = 'many';
    expect(fromEnv).toThrow('BILINFO_MAX_CONCURRENCY');
    delete process.env.BILINFO_MAX_CONCURRENCY;
    process.env.BILINFO_MAX_RESPONSE_BYTES = '10MB';
    expect(fromEnv).toThrow('BILINFO_MAX_RESPONSE_BYTES');
    delete process.env.BILINFO_MAX_RESPONSE_BYTES;
    process.env.BILINFO_ALLOW_CUSTOM_BASE_URL = 'perhaps';
    expect(fromEnv).toThrow('BILINFO_ALLOW_CUSTOM_BASE_URL');
    delete process.env.BILINFO_ALLOW_CUSTOM_BASE_URL;

    expect(() => new BilinfoClient(options({ maxConcurrency: 0 }))).toThrow('maxConcurrency');
    expect(() => new BilinfoClient(options({ maxConcurrency: Number.NaN }))).toThrow('maxConcurrency');
    expect(() => new BilinfoClient(options({ timeoutMs: 2 ** 31 }))).toThrow('timeoutMs');
    expect(() => new BilinfoClient(options({ maxAttempts: 0 }))).toThrow('maxAttempts');
  });
});

describe('error handling', () => {
  it('gives the status and our own Danish hint, never the vendor body or code', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ code: 'invalid_login', message: 'Unrecognized account' }, 401));
    const error = await makeClient(fetchImpl).get('/api/export').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BilinfoHttpError);
    expect((error as BilinfoHttpError).status).toBe(401);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).toContain('Bilinfo afviste de oplysninger, forbindelsen er sat op med');
    expect((error as Error).message).not.toContain('Unrecognized account');
    expect((error as Error).message).not.toContain('invalid_login');
  });

  it('never puts an error body in the error', async () => {
    const html = `<html>${'x'.repeat(5000)}</html>`;
    const fetchImpl = makeFetch(() => new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }));
    const error = (await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/api/export')
      .catch((e: unknown) => e)) as BilinfoHttpError;
    expect(error.message).toBe('Bilinfo svarede med en fejl (HTTP 502). Bilinfo har problemer lige nu. Prøv igen om lidt.');

    const plain = (await makeClient(makeFetch(() => jsonResponse({ message: 'nope' }, 418)))
      .get('/api/export')
      .catch((e: unknown) => e)) as BilinfoHttpError;
    expect(plain.message).toBe('Bilinfo svarede med en fejl (HTTP 418).');
  });

  it('reads at most 64 KB of an error body', async () => {
    let pulled = 0;
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new TextEncoder().encode('e'.repeat(16 * 1024)));
            },
          }),
          { status: 500, headers: { 'content-type': 'text/html' } },
        ),
    );
    const error = (await makeClient(fetchImpl)
      .get('/api/export')
      .catch((e: unknown) => e)) as BilinfoHttpError;
    expect(error).toBeInstanceOf(BilinfoHttpError);
    expect(pulled).toBeLessThan(10);
    expect(error.message.length).toBeLessThan(700);
  });

  it('redacts the password and the encoded credentials wherever they appear, before truncating', async () => {
    const password = 'live-pass-0123456789abcdef';
    const encoded = basicCredentials('fjordby-test', password);
    const respond = (body: string, type = 'text/plain') =>
      makeClient(makeFetch(() => new Response(body, { status: 400, headers: { 'content-type': type } })), {
        username: 'fjordby-test',
        password,
      });

    const echoed = (await respond(`proxy error: ${password} and ${encodeURIComponent(password)} and Basic ${encoded}`)
      .get('/api/export')
      .catch((e: unknown) => e)) as BilinfoHttpError;
    expect(echoed.message).not.toContain(password);
    expect(echoed.message).not.toContain(encoded);
    expect(echoed.message).not.toContain('proxy error');

    const boundary = (await respond(`${'x'.repeat(490)}${password}`)
      .get('/api/export')
      .catch((e: unknown) => e)) as BilinfoHttpError;
    expect(boundary.message).not.toContain(password.slice(0, 6));

    const nested = (await respond(JSON.stringify({ message: 'bad', nested: { echo: password } }), 'application/json')
      .get('/api/export')
      .catch((e: unknown) => e)) as BilinfoHttpError;
    expect(JSON.stringify(nested)).not.toContain(password);

    // The client's own redactor knows both forms.
    const client = respond('');
    expect(client.redactor.redact(`sent ${password}`)).not.toContain(password);
    expect(client.redactor.redact(`sent Basic ${encoded}`)).not.toContain(encoded.slice(0, 12));

    expect(redactSecrets('Authorization: Basic abc123')).not.toContain('abc123');
    expect(redactSecrets('Authorization: Bearer abc123')).not.toContain('abc123');
    expect(redactSecrets('BILINFO_PASSWORD=abc123')).not.toContain('abc123');
    expect(redactSecrets('{"password":"abc123"}')).not.toContain('abc123');
  });

  it('redacts the credential header by name', () => {
    const redactor = new SecretRedactor().addHeader('X-Vendor-Token').addHeader(CREDENTIAL_HEADER);
    const redact = (text: string) => redactor.redact(text);
    expect(redact('sent x-vendor-token: abc123, ok')).toBe('sent x-vendor-token: ‹redacted›, ok');
    expect(redact(`${CREDENTIAL_HEADER}: Basic abc123`)).not.toContain('abc123');
    for (const text of [
      '{"X-Vendor-Token":"abc123"}',
      "{'x-vendor-token': 'abc123'}",
      'x-vendor-token=abc123',
      `{"${CREDENTIAL_HEADER}": "Basic abc123"}`,
      '{"authorization":"Bearer abc123"}',
      'authorization=abc123',
      'X-Vendor-Token=abc123=def',
      'authorization=abc123:pass',
      'Authorization: Basic abc123',
      'Authorization: Token abc123',
      '"Authorization": "Digest abc123"',
    ]) {
      expect(redact(text), text).not.toContain('abc123');
    }
  });

  it('keeps query strings out of error URLs', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 400));
    const error = (await makeClient(fetchImpl)
      .get('/api/export', { dealerId: DEALER })
      .catch((e: unknown) => e)) as BilinfoHttpError;
    expect(error.url).toBe(`${BASE}/api/export`);
    expect(error.message).not.toContain(DEALER);
  });

  it('parses Retry-After as seconds or an HTTP date', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('5', now)).toBe(5000);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    for (const value of ['0', 'Wed, 31 Dec 2025 23:59:00 GMT', 'soon', '1.5', '-1', '+5', '']) {
      expect(parseRetryAfterMs(value, now)).toBeUndefined();
    }
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it('names only the system error code of a network error, never its message or the address', async () => {
    const fetchImpl = makeFetch(() => {
      throw new TypeError('fetch failed somewhere odd', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND listing.bilinfo.test'), { code: 'ENOTFOUND' }),
      });
    });
    const message = await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/api/export')
      .catch((e: Error) => e.message);
    expect(message).toBe('Der kunne ikke oprettes forbindelse til Bilinfo. Prøv igen om lidt. (ENOTFOUND)');
    expect(message).not.toMatch(/odd|getaddrinfo|bilinfo\.test/);
  });

  it('reports timeouts clearly', async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(makeClient(fetchImpl, { timeoutMs: 2500, maxAttempts: 1 }).get('/api/export')).rejects.toThrow(
      'Bilinfo svarede ikke inden for 2,5 sekunder. Prøv igen om lidt.',
    );
  });

  it('caps successful response bodies', async () => {
    const big = makeFetch(
      () => new Response('x'.repeat(100), { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(makeClient(big, { maxResponseBytes: 10 }).get('/api/export')).rejects.toThrow('grænsen er 10 bytes');
    await expect(makeClient(big, { maxResponseBytes: 1000 }).get('/api/export')).resolves.toBe('x'.repeat(100));
  });
});

describe('redirects', () => {
  it('never follows redirects and never quotes the target', async () => {
    const fetchImpl = makeFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://other.vendor.test/listingapi/api/export?t=1' } }),
    );
    const message = await makeClient(fetchImpl)
      .get('/api/export')
      .catch((e: Error) => e.message);
    expect(message).toContain('Bilinfo henviste til en anden adresse (HTTP 302)');
    expect(message).toContain('Henvisninger følges ikke');
    // The Location is the vendor's text: never quoted.
    expect(message).not.toContain('other.vendor.test');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('other.vendor.test'))).toBe(true);
  });
});

describe('retries and concurrency', () => {
  it('retries on 429/502/503/504 honouring Retry-After', async () => {
    const statuses = [503, 429];
    const fetchImpl = makeFetch(() => {
      const status = statuses.shift();
      if (status === 429) {
        return jsonResponse({}, 429, { 'retry-after': '2' });
      }
      if (status) {
        return jsonResponse({}, status);
      }
      return { ok: true };
    });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = makeClient(fetchImpl, { sleep, retryBaseDelayMs: 10 });

    await expect(client.get('/api/export')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1]).toEqual([2000]);
  });

  it('does not wait for a Retry-After beyond the retry budget and surfaces it', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503, { 'retry-after': '3600' }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const error = (await makeClient(fetchImpl, { sleep })
      .get('/api/export')
      .catch((e: unknown) => e)) as BilinfoHttpError;

    expect(error).toBeInstanceOf(BilinfoHttpError);
    expect(error.message).toContain('Bilinfo beder om at vente 3600 sekunder.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on transient network errors only', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      }
      return { ok: true };
    });
    await expect(makeClient(fetchImpl).get('/api/export')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);

    const permanent = makeFetch(() => {
      throw new TypeError('Headers.append: invalid header value');
    });
    await expect(makeClient(permanent).get('/api/export')).rejects.toThrow('Der kunne ikke oprettes forbindelse til Bilinfo');
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it('releases the concurrency slot after failures', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new DOMException('timeout', 'TimeoutError');
      }
      if (calls === 2) {
        return jsonResponse({}, 500);
      }
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 1, maxAttempts: 1 });
    await expect(client.get('/api/export')).rejects.toThrow('svarede ikke inden for');
    await expect(client.get('/api/export')).rejects.toBeInstanceOf(BilinfoHttpError);
    await expect(client.get('/api/export')).resolves.toEqual({ ok: true });
  });

  it('limits concurrent requests per client', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = makeFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 2 });

    await Promise.all(Array.from({ length: 8 }, () => client.get('/api/export')));
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(peak).toBe(2);
  });
});

describe('against a local upstream (real sockets)', () => {
  let upstream: Server | undefined;

  afterEach(async () => {
    await new Promise<void>(resolve => (upstream ? upstream.close(() => resolve()) : resolve()));
    upstream = undefined;
  });

  async function startUpstream(handler: Parameters<typeof createHttpServer>[1]): Promise<string> {
    upstream = createHttpServer(handler);
    await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/listingapi`;
  }

  it('sends the credentials, refuses a redirect and does not contact the redirect target', async () => {
    const seen: Array<{ url?: string; credentials?: string }> = [];
    const base = await startUpstream((req, res) => {
      seen.push({ url: req.url, credentials: req.headers[CREDENTIAL_HEADER.toLowerCase()] as string | undefined });
      if (req.url === '/listingapi/api/export') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"Vehicles":[]}');
        return;
      }
      res.writeHead(302, { location: `${base}/api/export` }).end();
    });
    const client = new BilinfoClient({ username: 'local-user', password: 'local-pass-123456', baseUrl: base, credentialEnv: {} });
    const sent = `Basic ${basicCredentials('local-user', 'local-pass-123456')}`;

    await expect(client.get('/api/export')).resolves.toEqual({ Vehicles: [] });
    await expect(client.get('/moved')).rejects.toThrow('Henvisninger følges ikke');
    expect(seen).toEqual([
      { url: '/listingapi/api/export', credentials: sent },
      { url: '/listingapi/moved', credentials: sent },
    ]);
  });

  it('times out a stalled upstream', async () => {
    const base = await startUpstream(() => {
      // never answers
    });
    const client = new BilinfoClient({ username: 'u', password: 'p', baseUrl: base, credentialEnv: {}, timeoutMs: 100, maxAttempts: 1 });
    await expect(client.get('/slow')).rejects.toThrow('Bilinfo svarede ikke inden for 0,1 sekunder');
    upstream?.closeAllConnections();
  });
});
