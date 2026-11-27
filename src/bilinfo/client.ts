import { Buffer } from 'node:buffer';
import { ConfigError, readEnvBoolean, readEnvInteger, readEnvString, type Env } from '../config-env.js';
import {
  BilinfoHttpError,
  describeUrl,
  parseRetryAfterMs,
  requestIdFrom,
  SecretRedactor,
  TOKEN_REFUSED_HINT,
  UpstreamRedirectError,
} from '../errors.js';
import { USER_AGENT } from '../version.js';

export interface BilinfoClientOptions {
  /** User name of the Bilinfo API account (Listing API). When omitted, read from BILINFO_USERNAME in `credentialEnv`. */
  username?: string;
  /** Password of the Bilinfo API account (Listing API). When omitted, read from BILINFO_PASSWORD in `credentialEnv`. */
  password?: string;
  /**
   * Client id of a client registered with Bilinfo's authorization service (OAuth 2.0, client credentials). The
   * services other than the Listing API need it. When omitted, read from BILINFO_CLIENT_ID in `credentialEnv`.
   */
  clientId?: string;
  /** Client secret that goes with `clientId`. When omitted, read from BILINFO_CLIENT_SECRET in `credentialEnv`. */
  clientSecret?: string;
  /**
   * Subscription key of Bilinfo's API gateway (the header Ocp-Apim-Subscription-Key), for the services on
   * publicapi.bilinfo.net (Car API, Leads API, Model Catalog). Bilinfo's own Car API example sends one; the developer
   * portal marks it as optional. When omitted, read from BILINFO_SUBSCRIPTION_KEY in `credentialEnv`; without one,
   * none is sent.
   */
  subscriptionKey?: string;
  /**
   * Which of Bilinfo's environments the services are called in: `production` (default) or `qa`, Bilinfo's test
   * environment that an integration goes through before production. When omitted, read from BILINFO_ENVIRONMENT in
   * `credentialEnv`.
   */
  environment?: BilinfoEnvironment;
  /** Addresses of single services, for a mock. They pass the same host check as `baseUrl`. */
  serviceUrls?: Partial<Record<Exclude<BilinfoService, 'listing'>, string>>;
  /**
   * GUID of one Bilinfo dealer (Bilinfo -> Dealer settings). When set, every
   * read is limited to that dealer's vehicles and leads; Bilinfo offers the
   * filter for accounts that cover several dealers. The Car API needs it: a car
   * is always created, changed and sold for this dealer and no other. When
   * omitted, read from BILINFO_DEALER_ID in `credentialEnv`.
   */
  dealerId?: string;
  /**
   * Base URL of the Listing API. When omitted, read from BILINFO_BASE_URL in `credentialEnv`, else the Listing API's
   * address in the environment (SERVICE_URLS).
   */
  baseUrl?: string;
  /**
   * Where omitted credentials (username, password, clientId, clientSecret, subscriptionKey, dealerId, environment,
   * baseUrl) are read from. Defaults to
   * process.env for the standalone server. The gateway passes `{}`, so an
   * embedded instance only ever uses the credentials it was given.
   */
  credentialEnv?: Env;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout covering headers and body (default 30 s, env BILINFO_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Maximum number of concurrent upstream requests from this client (default 4, env BILINFO_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Largest successful response body read, in bytes (default 10 MB, env BILINFO_MAX_RESPONSE_BYTES). */
  maxResponseBytes?: number;
  /** Total attempts for reads on 429/502/503/504 and transient network errors (default 3). A change is sent once. */
  maxAttempts?: number;
  /** Base delay of the exponential backoff between retries (default 500 ms). */
  retryBaseDelayMs?: number;
  /**
   * Total time one call may spend waiting between retries (default 10 s). A
   * Retry-After that does not fit in the remaining budget is not waited for;
   * the response is returned to the caller instead.
   */
  retryBudgetMs?: number;
  /** Allow a base URL outside UPSTREAM_HOST_SUFFIXES (env BILINFO_ALLOW_CUSTOM_BASE_URL=true). */
  allowCustomBaseUrl?: boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type QueryValue = string | number | boolean | null | undefined;

/** GET reads; POST and PUT change something (a car, a lead), except the POST that asks for an access token. */
type HttpMethod = 'GET' | 'PUT' | 'POST';

/** Header that carries the credentials (HTTP Basic or a Bearer token); error text redaction follows it. */
export const CREDENTIAL_HEADER = 'Authorization';

/** The Listing API's address in production, as its documentation gives it. */
export const DEFAULT_BASE_URL = 'https://gw.bilinfo.net/listingapi';

/**
 * Subscription key header of Bilinfo's API gateway (Azure API Management), as Bilinfo's Car API example sends it.
 * A secret of the instance: redacted like the credentials.
 */
export const SUBSCRIPTION_KEY_HEADER = 'Ocp-Apim-Subscription-Key';

/**
 * The services of Bilinfo this client can call. `token` is the authorization service; `cars` is the Car API,
 * `leads` the Leads API and `models` the Model Catalog.
 */
export type BilinfoService = 'listing' | 'token' | 'cars' | 'leads' | 'models';
export type BilinfoEnvironment = 'production' | 'qa';

/**
 * The addresses per environment. The QA addresses are the ones Bilinfo's developer portal (developer.bilinfo.net)
 * publishes for each API (carapiqa, leadsapiqa, modelcatalogqa and listingapiqa on publicapi.bilinfo.net) and the
 * token endpoints of the Auth Services document (v1.2.2). The production addresses of the Car API, Leads API and
 * Model Catalog are the same paths without "qa": the portal does not list them, so they are to be confirmed with
 * Bilinfo during onboarding.
 */
export const SERVICE_URLS: Readonly<Record<BilinfoEnvironment, Readonly<Record<BilinfoService, string>>>> = {
  production: {
    listing: DEFAULT_BASE_URL,
    token: 'https://accounts.ecgh.dk/oauth/connect/token',
    cars: 'https://publicapi.bilinfo.net/carapi',
    leads: 'https://publicapi.bilinfo.net/leadsapi',
    models: 'https://publicapi.bilinfo.net/modelcatalog',
  },
  qa: {
    listing: 'https://publicapi.bilinfo.net/listingapiqa',
    token: 'https://accounts.qa01.ecgh.dk/oauth/connect/token',
    cars: 'https://publicapi.bilinfo.net/carapiqa',
    leads: 'https://publicapi.bilinfo.net/leadsapiqa',
    models: 'https://publicapi.bilinfo.net/modelcatalogqa',
  },
};

/**
 * Where a request goes and how it is authorized. Without a scope it is the
 * Listing API with HTTP Basic; with one, an access token for that scope is
 * fetched from Bilinfo's authorization service first.
 */
export interface ApiTarget {
  service: Exclude<BilinfoService, 'token'>;
  scope?: string;
}

export const LISTING_API: ApiTarget = { service: 'listing' };

/**
 * Hosts the credentials may be sent to (exact host or any subdomain): the
 * two domains Bilinfo's documents use. Loopback http is always allowed for
 * local mocks.
 */
export const UPSTREAM_HOST_SUFFIXES: readonly string[] = ['bilinfo.net', 'ecgh.dk'];

/** A Bilinfo dealer id is a GUID (Listing API document and the Car API's path). */
export const DEALER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The value of the Authorization header for HTTP Basic, after the scheme:
 * the name and the secret joined by a colon, as UTF-8, in base64. It carries
 * the user name and password of the Listing API account, and the client id
 * and client secret towards the authorization service.
 *
 * The secret is sent exactly as given: any length, with spaces, with æ, ø
 * and å. Only a name with a colon is refused, because HTTP Basic cannot
 * carry one: the receiver would split the pair in the wrong place.
 */
export function basicCredentials(name: string, secret: string): string {
  if (name.includes(':')) {
    // The values are not quoted: a credential is never echoed.
    throw new ConfigError('The Bilinfo user name or client id must not contain a colon: HTTP Basic cannot carry one.');
  }
  return Buffer.from(`${name}:${secret}`, 'utf8').toString('base64');
}

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES_LIMIT = 100 * 1024 * 1024;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/** Largest delay accepted by Node timers. */
const MAX_TIMER_MS = 2_147_483_647;
/** Error codes (on `error.cause`) of connection-level failures worth retrying. */
/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * The client as handed to tool handlers. Read-only tools get a view whose
 * POST and PUT throw (see readOnlyClient), so the write gate does not depend
 * on tool annotations alone.
 */
export interface UpstreamClient {
  /** Read. Without a target it is the Listing API. */
  get<T>(path: string, query?: Record<string, QueryValue>, target?: ApiTarget): Promise<T>;
  /** Change. Sent once, never retried. */
  post<T>(path: string, body: unknown, target: ApiTarget): Promise<T>;
  /** Change. Sent once, never retried. */
  put<T>(path: string, body: unknown, target: ApiTarget): Promise<T>;
  /** Ask for an access token for the target's scope and drop it: whether Bilinfo issues one. Changes nothing. */
  probeToken(target: ApiTarget): Promise<void>;
  /** The dealer every read is limited to and every car belongs to, when the instance was given one. */
  readonly dealerId?: string;
}

/** A view of the client that only allows GET. */
export function readOnlyClient(client: UpstreamClient, toolName: string): UpstreamClient {
  const refuse = (method: string) => async () => {
    throw new Error(`Read-only tool ${toolName} attempted an upstream ${method}; refused.`);
  };
  return {
    get: (path, query, target) => client.get(path, query, target),
    probeToken: target => client.probeToken(target),
    post: refuse('POST'),
    put: refuse('PUT'),
    dealerId: client.dealerId,
  };
}

/**
 * Client for Bilinfo's services. Two ways in, as Bilinfo documents them:
 * - the Listing API takes HTTP Basic: the user name and password of a
 *   Bilinfo API account;
 * - every other service takes a Bearer token, which Bilinfo's authorization
 *   service issues for a client id, a client secret and the scope of the
 *   service (OAuth 2.0, client credentials).
 * An instance may have either pair or both; a call that needs the missing
 * one says so.
 *
 * Redirects are never followed, so the credentials cannot be forwarded to
 * another origin. Reads are retried with backoff on throttling, gateway
 * errors and transient network failures; a change is sent once. Missing
 * credentials only fail when a request is made, so the tool list can be read
 * without them.
 *
 * Nothing is kept between calls: every request goes to Bilinfo, and its
 * answer is handed to the caller and forgotten. That includes the access
 * token: each call asks for its own and drops it when the call is over.
 *
 * Each client owns a SecretRedactor holding its own secrets; errors raised
 * by the client, and the audit and tool results of calls made through it,
 * are redacted with it.
 */
export class BilinfoClient implements UpstreamClient {
  readonly redactor: SecretRedactor;
  /** The encoded credentials of the Listing API account (basicCredentials), when both parts are known. */
  private readonly credentials?: string;
  /** The encoded client id and secret for the authorization service, when both parts are known. */
  private readonly clientCredentials?: string;
  /** The API gateway's subscription key, when the instance was given one. */
  private readonly subscriptionKey?: string;
  readonly dealerId?: string;
  readonly baseUrl: string;
  private readonly urls: Readonly<Record<BilinfoService, string>>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryBudgetMs: number;
  private readonly semaphore: Semaphore;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: BilinfoClientOptions = {}) {
    const credentialEnv = options.credentialEnv ?? process.env;
    const username = options.username ?? readEnvString('BILINFO_USERNAME', credentialEnv);
    const password = options.password ?? readEnvString('BILINFO_PASSWORD', credentialEnv);
    this.redactor = new SecretRedactor().addHeader(CREDENTIAL_HEADER).addHeader(SUBSCRIPTION_KEY_HEADER).addSecret(password);
    if (username && password) {
      this.credentials = basicCredentials(username, password);
      // What is sent is the encoded form: it is a secret of this instance as well.
      this.redactor.addSecret(this.credentials);
    }
    const clientId = options.clientId ?? readEnvString('BILINFO_CLIENT_ID', credentialEnv);
    const clientSecret = options.clientSecret ?? readEnvString('BILINFO_CLIENT_SECRET', credentialEnv);
    this.redactor.addSecret(clientSecret);
    if (clientId && clientSecret) {
      this.clientCredentials = basicCredentials(clientId, clientSecret);
      this.redactor.addSecret(this.clientCredentials);
    }
    const subscriptionKey = options.subscriptionKey ?? readEnvString('BILINFO_SUBSCRIPTION_KEY', credentialEnv);
    if (typeof subscriptionKey === 'string' && subscriptionKey !== '') {
      this.subscriptionKey = subscriptionKey;
      this.redactor.addSecret(subscriptionKey);
    }
    const dealerId = options.dealerId ?? readEnvString('BILINFO_DEALER_ID', credentialEnv);
    if (dealerId !== undefined) {
      if (typeof dealerId !== 'string' || !DEALER_ID_PATTERN.test(dealerId.trim())) {
        // The value is not quoted: a configuration value is never echoed.
        throw new ConfigError('The Bilinfo dealer id (dealerId, BILINFO_DEALER_ID) must be a GUID, as shown in Bilinfo under Dealer settings.');
      }
      this.dealerId = dealerId.trim().toLowerCase();
    }
    const environment = options.environment ?? readEnvString('BILINFO_ENVIRONMENT', credentialEnv) ?? 'production';
    if (environment !== 'production' && environment !== 'qa') {
      throw new ConfigError('The Bilinfo environment (environment, BILINFO_ENVIRONMENT) must be production or qa.');
    }
    this.baseUrl = trimTrailingSlash(
      options.baseUrl ?? readEnvString('BILINFO_BASE_URL', credentialEnv) ?? SERVICE_URLS[environment].listing,
    );
    const allowCustomHost = options.allowCustomBaseUrl ?? readEnvBoolean('BILINFO_ALLOW_CUSTOM_BASE_URL', false);
    const urls: Record<BilinfoService, string> = { ...SERVICE_URLS[environment], listing: this.baseUrl };
    for (const [service, url] of Object.entries(options.serviceUrls ?? {})) {
      if (service !== 'listing' && Object.hasOwn(urls, service) && typeof url === 'string') {
        urls[service as BilinfoService] = trimTrailingSlash(url);
      }
    }
    for (const [service, url] of Object.entries(urls)) {
      assertSafeBaseUrl(url, allowCustomHost, service === 'listing' ? 'BILINFO_BASE_URL' : `serviceUrls.${service}`);
    }
    this.urls = urls;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = intOption('timeoutMs', options.timeoutMs, 'BILINFO_TIMEOUT_MS', 30_000, 1, MAX_TIMER_MS);
    this.maxResponseBytes = intOption(
      'maxResponseBytes',
      options.maxResponseBytes,
      'BILINFO_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES_LIMIT,
    );
    this.semaphore = new Semaphore(
      intOption('maxConcurrency', options.maxConcurrency, 'BILINFO_MAX_CONCURRENCY', 4, 1, 64),
    );
    this.maxAttempts = intOption('maxAttempts', options.maxAttempts, undefined, 3, 1, 10);
    this.retryBaseDelayMs = intOption('retryBaseDelayMs', options.retryBaseDelayMs, undefined, 500, 0, 60_000);
    this.retryBudgetMs = intOption('retryBudgetMs', options.retryBudgetMs, undefined, 10_000, 0, 600_000);
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async get<T>(path: string, query?: Record<string, QueryValue>, target: ApiTarget = LISTING_API): Promise<T> {
    return this.request<T>('GET', target, this.buildUrl(path, query, target.service));
  }

  async probeToken(target: ApiTarget): Promise<void> {
    if (target.scope === undefined) {
      throw new Error('probeToken needs a target with a scope');
    }
    await this.accessToken(target.scope);
  }

  async post<T>(path: string, body: unknown, target: ApiTarget): Promise<T> {
    return this.request<T>('POST', target, this.buildUrl(path, undefined, target.service), body);
  }

  async put<T>(path: string, body: unknown, target: ApiTarget): Promise<T> {
    return this.request<T>('PUT', target, this.buildUrl(path, undefined, target.service), body);
  }

  buildUrl(path: string, query?: Record<string, QueryValue>, service: BilinfoService = 'listing'): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.urls[service]}${normalizedPath}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  /** The value of the Authorization header for a target: Basic for the Listing API, else a fresh Bearer token. */
  private async authorization(target: ApiTarget): Promise<string> {
    if (target.scope === undefined) {
      if (!this.credentials) {
        throw new MissingCredentialsError('listing', MISSING_CREDENTIALS);
      }
      return `Basic ${this.credentials}`;
    }
    return `Bearer ${await this.accessToken(target.scope)}`;
  }

  /**
   * Ask Bilinfo's authorization service for an access token for one scope (client credentials flow: the client id
   * and secret as HTTP Basic, the grant type and the scope as a form). Asking changes nothing, so it is retried like
   * a read. The token is used for the one request that follows and is not kept.
   */
  private async accessToken(scope: string): Promise<string> {
    if (!this.clientCredentials) {
      throw new MissingCredentialsError('client', MISSING_CLIENT);
    }
    const init: RequestInit = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        [CREDENTIAL_HEADER]: `Basic ${this.clientCredentials}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
    };
    // Asking for a token changes nothing: it may be retried like a read.
    const answer = await this.send('POST', this.urls.token, init, { refusedStatus: TOKEN_REFUSED_STATUS, retry: true });
    const token = answer !== null && typeof answer === 'object' ? (answer as { access_token?: unknown }).access_token : undefined;
    if (typeof token !== 'string' || token === '') {
      throw new Error(TOKEN_UNREADABLE);
    }
    return token;
  }

  private async request<T>(method: HttpMethod, target: ApiTarget, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      [CREDENTIAL_HEADER]: await this.authorization(target),
    };
    // The API gateway's key goes to the services behind it: never to the Listing API or the token service.
    if (this.subscriptionKey && target.service !== 'listing') {
      headers[SUBSCRIPTION_KEY_HEADER] = this.subscriptionKey;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    // A read may be retried; a change is sent once.
    return (await this.send(method, url, init, { retry: method === 'GET' })) as T;
  }

  /**
   * One request and its answer. `retry` says whether it may be sent again (a read, or the token request);
   * `refusedStatus` lists the statuses that mean the authorization service said no.
   */
  private send(
    method: HttpMethod,
    url: string,
    init: RequestInit,
    { retry, refusedStatus }: { retry: boolean; refusedStatus?: ReadonlySet<number> },
  ): Promise<unknown> {
    return this.execute(method, url, init, retry, async response => {
      if (isRedirect(response.status)) {
        await discardBody(response);
        throw new UpstreamRedirectError(this.redactor.redact(redirectRefusedMessage(response, method, url)), {
          status: response.status,
          requestId: requestIdFrom(response.headers),
        });
      }

      if (!response.ok) {
        // The body is the vendor's text: it is never read into an error, a result or an audit record.
        await discardBody(response);
        throw new BilinfoHttpError({
          status: response.status,
          url: describeUrl(url),
          retryAfter: response.headers.get('retry-after') ?? undefined,
          requestId: requestIdFrom(response.headers),
          ...(refusedStatus?.has(response.status) ? { hint: TOKEN_REFUSED_HINT } : {}),
        });
      }

      return readResponseBody(response, this.maxResponseBytes);
    });
  }

  /**
   * Run one logical request: limit concurrency, apply the timeout, and (only
   * when `retry`: a read or the token request, never a change) retry on
   * retryable statuses and transient network errors within the retry budget.
   * `handle` runs while the concurrency slot is held, so body reads count
   * against it.
   */
  private async execute<R>(
    method: HttpMethod,
    url: string,
    init: RequestInit,
    retry: boolean,
    handle: (response: Response) => Promise<R>,
  ): Promise<R> {
    // A change is never sent twice: after a lost answer nobody knows whether the first one arrived.
    const maxAttempts = retry ? this.maxAttempts : 1;
    let slept = 0;

    for (let attempt = 1; ; attempt += 1) {
      const canRetry = attempt < maxAttempts;
      let delayMs: number | undefined;
      const release = await this.semaphore.acquire();
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        let response: Response | undefined;
        try {
          response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal });
        } catch (error) {
          delayMs = canRetry && isTransientNetworkError(error) ? this.retryDelay(attempt, undefined, slept) : undefined;
          if (delayMs === undefined) {
            throw this.transportError(method, url, error);
          }
        }

        if (response) {
          if (canRetry && RETRYABLE_STATUS.has(response.status)) {
            delayMs = this.retryDelay(attempt, parseRetryAfterMs(response.headers.get('retry-after')), slept);
          }
          if (delayMs === undefined) {
            try {
              return await handle(response);
            } catch (error) {
              // Failures while reading the body surface as raw fetch errors.
              if (isTimeoutError(error)) {
                throw this.transportError(method, url, error);
              }
              if (!isTransientNetworkError(error)) {
                throw error;
              }
              delayMs = canRetry ? this.retryDelay(attempt, undefined, slept) : undefined;
              if (delayMs === undefined) {
                throw this.transportError(method, url, error);
              }
            }
          }
          await discardBody(response);
        }
      } finally {
        release();
      }
      // Wait outside the concurrency slot.
      const wait = delayMs ?? 0;
      slept += wait;
      await this.sleep(wait);
    }
  }

  /**
   * Delay before the next attempt: exponential backoff with jitter, or the
   * server's Retry-After if longer. Undefined when the wait would exceed the
   * remaining retry budget (the caller then gives up).
   */
  private retryDelay(attempt: number, retryAfterMs: number | undefined, slept: number): number | undefined {
    const backoff = this.retryBaseDelayMs * 2 ** (attempt - 1) + Math.random() * this.retryBaseDelayMs;
    const delay = Math.max(backoff, retryAfterMs ?? 0);
    return slept + delay > this.retryBudgetMs ? undefined : delay;
  }

  // Our own words only: the address is configuration and is not quoted.
  private transportError(_method: HttpMethod, _url: string, error: unknown): Error {
    if (isTimeoutError(error)) {
      return new Error(this.redactor.redact(timeoutText(this.timeoutMs)));
    }
    // Only a system error code (ECONNREFUSED, ENOTFOUND, ...) from the cause, never its message.
    const code = (error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined) ?? undefined;
    const shown = typeof code === 'string' && SHOWN_NETWORK_CODES.has(code) ? ` (${code})` : '';
    return new Error(this.redactor.redact(`${NETWORK_ERROR}${shown}`), { cause: error });
  }
}

/** Option value if given (validated), else the environment variable (if any), else the default. */
function intOption(
  optionName: string,
  value: number | undefined,
  envName: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value !== undefined) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      // The value is not quoted: an option may hold a secret put there by mistake.
      throw new ConfigError(`${optionName} must be an integer between ${min} and ${max}.`);
    }
    return value;
  }
  return envName ? readEnvInteger(envName, fallback, { min, max }) : fallback;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // hand the slot over directly
      } else {
        this.active -= 1;
      }
    };
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** The redirect's Location is the vendor's text and is never quoted; only the status and our own words. */
function redirectRefusedMessage(response: Response, _method: HttpMethod, _url: string): string {
  return `Bilinfo henviste til en anden adresse (HTTP ${response.status}). Henvisninger følges ikke, så der blev ikke hentet noget.`;
}

/** Thrown when the instance was not given the credentials a request needs: nothing was sent. */
export class MissingCredentialsError extends Error {
  /** `listing`: the Listing API account; `client`: the client id and secret. */
  readonly missing: 'listing' | 'client';
  constructor(missing: 'listing' | 'client', message: string) {
    super(message);
    this.name = 'MissingCredentialsError';
    this.missing = missing;
  }
}

/** Texts a person may read, in Danish. They never hold a credential, an address or anything Bilinfo wrote. */
const MISSING_CREDENTIALS =
  'Denne forbindelse er ikke sat op til at læse biler til salg: brugernavn og adgangskode til Bilinfo mangler (BILINFO_USERNAME og BILINFO_PASSWORD).';
const MISSING_CLIENT =
  'Denne forbindelse er ikke sat op til biler, kundehenvendelser og modelopslag: klient-id og hemmelighed fra Bilinfo mangler (BILINFO_CLIENT_ID og BILINFO_CLIENT_SECRET).';
const TOKEN_UNREADABLE = 'Bilinfo gav ikke adgang: svaret fra Bilinfos adgangstjeneste kunne ikke læses.';
/** What the authorization service answers when it will not issue a token for the client and the scope. */
const TOKEN_REFUSED_STATUS: ReadonlySet<number> = new Set([400, 401, 403]);
const NETWORK_ERROR = 'Der kunne ikke oprettes forbindelse til Bilinfo. Prøv igen om lidt.';
const RESPONSE_UNREADABLE = 'Svaret fra Bilinfo kunne ikke læses.';

function timeoutText(timeoutMs: number): string {
  const seconds = (Math.round(timeoutMs / 100) / 10).toLocaleString('da-DK');
  return `Bilinfo svarede ikke inden for ${seconds} sekunder. Prøv igen om lidt.`;
}

function tooLargeText(maxBytes: number): string {
  return `Svaret fra Bilinfo er større, end der kan læses på én gang (grænsen er ${maxBytes} bytes, BILINFO_MAX_RESPONSE_BYTES).`;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** fetch reports connection failures as TypeError with a coded cause; only those are retried. */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  return causeCodes(error.cause).some(code => TRANSIENT_NETWORK_CODES.has(code));
}

function causeCodes(cause: unknown, depth = 0): string[] {
  if (typeof cause !== 'object' || cause === null || depth > 3) {
    return [];
  }
  const codes: string[] = [];
  const { code, errors, cause: inner } = cause as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof code === 'string') {
    codes.push(code);
  }
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      codes.push(...causeCodes(entry, depth + 1));
    }
  }
  codes.push(...causeCodes(inner, depth + 1));
  return codes;
}

/** Read at most `limit` bytes of the body; cancels the rest and reports whether it was longer. */
async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), exceeded: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/** Successful bodies are read up to maxBytes; a larger response is an error, not a truncated result. */
async function readResponseBody(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    throw new Error(tooLargeText(maxBytes));
  }
  let read: { bytes: Uint8Array; exceeded: boolean };
  try {
    read = await readUpTo(response, maxBytes);
  } catch (error) {
    // A timeout or a dropped connection goes on to execute(), which reports it as a transport error. Anything else
    // thrown while reading the body is replaced by a fixed text: its message is not ours.
    if (isTimeoutError(error) || isTransientNetworkError(error)) {
      throw error;
    }
    throw new Error(RESPONSE_UNREADABLE);
  }
  const { bytes, exceeded } = read;
  if (exceeded) {
    throw new Error(tooLargeText(maxBytes));
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

/** `label` names the setting in the refusal (our own word for it, never its value). */
function assertSafeBaseUrl(baseUrl: string, allowCustomHost: boolean, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigError(`${label} is not a valid URL.`);
  }

  if (parsed.username || parsed.password || baseUrl.includes('?') || baseUrl.includes('#')) {
    throw new ConfigError(`${label} must not contain credentials, a query string or a fragment.`);
  }

  if (isLocalHost(parsed.hostname) && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return;
  }

  if (parsed.protocol !== 'https:') {
    throw new ConfigError(
      // The scheme is not quoted: it is part of a configuration value.
      'Refusing to send the credentials over a scheme other than https://. Use https:// (loopback http:// is allowed for local mocks).',
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (
    UPSTREAM_HOST_SUFFIXES.length === 0 ||
    allowCustomHost ||
    UPSTREAM_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))
  ) {
    return;
  }

  // The host is not quoted: it is a configuration value.
  throw new ConfigError(
    `Refusing to send the credentials to that host: ${label} must be on ${UPSTREAM_HOST_SUFFIXES.join(', ')}. ` +
      'Set BILINFO_ALLOW_CUSTOM_BASE_URL=true to allow another host.',
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
