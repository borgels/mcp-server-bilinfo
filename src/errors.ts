/**
 * Errors and redaction.
 *
 * The rule: no text the upstream API controls ever reaches a host, a result
 * or an audit record through an error. An HTTP error carries the status, our
 * own hint for it, and a parsed Retry-After; never the response body, the
 * vendor's error code or message, or a redirect's Location. Upstream text can
 * quote the request, personal data, or part of a credential, and no redactor
 * recognises every fragment.
 *
 * Redaction is the second line: every instance redacts the secrets it can
 * recognise by their value (src/secrets.ts: the password, the client secret
 * and the encoded credentials, in their exact, URL-encoded and JSON-escaped
 * forms) from everything it returns, always on structured values before they
 * are serialised, and before anything is cut short.
 *
 * The texts of errors are in Danish: they are read by the person who asked.
 */
import { MIN_SECRET_LENGTH, recognisedByValue } from './secrets.js';

export { MIN_SECRET_LENGTH };
/** Values nested deeper than this are replaced by redactDeep, never passed on. */
export const MAX_REDACT_DEPTH = 64;
/** What a redacted value is replaced by. */
export const REDACTION_MARKER = '‹redacted›';

/** Matches `<name>: <value>`, `<name>=<value>` and `"<name>": "<value>"` for one header (case-insensitive). */
function headerPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`["']?${escaped}["']?\s*[:=]\s*["']?[^"',\s}]+`, 'gi');
}

/** Patterns that are always applied: credential-shaped key/value pairs. They hold no secret values. */
const BASE_PATTERNS: readonly RegExp[] = [
  // Any scheme word (Bearer, Basic, Token, ...) followed by the credentials.
  /["']?authorization["']?\s*[:=]\s*["']?(?:[a-z][\w-]*\s+)?[^"',\s}]+/gi,
  /(password|BILINFO_PASSWORD|adgangskode|client_secret|BILINFO_CLIENT_SECRET|access_token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

/**
 * Redacts the secrets of one client, and so of one gateway or server
 * instance: the exact values (raw, URL-encoded and JSON-escaped) of the
 * secrets that can be recognised by their value, and the values of named
 * credential headers. Each instance owns its redactor, so a host that runs
 * several tenants in one process never mixes their secrets, and a tenant's
 * secrets are released with its instance. There is no process-wide registry.
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();
  private readonly patterns: RegExp[] = [...BASE_PATTERNS];

  /**
   * Redact this value wherever it appears. A value that cannot be told from ordinary text (shorter than
   * MIN_SECRET_LENGTH, or a text of our own; see src/secrets.ts) is not looked for: it is still a valid secret.
   */
  addSecret(value: string | undefined): this {
    if (!recognisedByValue(value)) {
      return this;
    }
    this.secrets.add(value);
    this.secrets.add(JSON.stringify(value).slice(1, -1));
    try {
      this.secrets.add(encodeURIComponent(value));
    } catch {
      // A value with half a surrogate pair has no URL-encoded form.
    }
    return this;
  }

  /** Redact the value of this header wherever it appears as `<name>: <value>` or `<name>=<value>`. */
  addHeader(name: string): this {
    const pattern = headerPattern(name);
    if (!this.patterns.some(existing => existing.source === pattern.source)) {
      this.patterns.push(pattern);
    }
    return this;
  }

  /** Whether this exact value is one of the secrets this instance looks for. */
  hasSecret(value: string): boolean {
    return this.secrets.has(value);
  }

  /** Whether the text contains one of the secrets in any of its forms. */
  matches(text: string): boolean {
    for (const secret of this.secrets) {
      if (text.includes(secret)) return true;
    }
    return false;
  }

  redact(value: string): string {
    let result = value;
    // Longest first: a secret that contains another (the JSON-escaped form, say) is replaced whole.
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      result = result.split(secret).join(REDACTION_MARKER);
    }
    return applyPatterns(result, this.patterns);
  }
}

function applyPatterns(value: string, patterns: readonly RegExp[]): string {
  return patterns.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        // Split at the first separator only: the value may itself contain `:` or `=`.
        const [, key = 'secret', separator = ':'] = /^(.*?)\s*([:=])/.exec(match) ?? [];
        return `${key.trim()}${separator} ‹redacted›`;
      }),
    value,
  );
}

/**
 * Our own guidance per HTTP status, in Danish. The Listing API documents no error model; a request without valid
 * credentials is answered with 401. The other services document 400, 401, 403, 404 and 500 without a body format.
 */
const STATUS_HINTS: Record<number, string> = {
  400: 'Bilinfo kunne ikke bruge oplysningerne i forespørgslen.',
  401: 'Bilinfo afviste de oplysninger, forbindelsen er sat op med. Forbindelsen til Bilinfo skal sættes op igen med de oplysninger, Bilinfo har udleveret.',
  403: 'Kontoen hos Bilinfo har ikke adgang til disse oplysninger. Det hjælper ikke at prøve igen.',
  404: 'Bilinfo kunne ikke finde det, der blev spurgt efter.',
  429: 'Bilinfo har fået for mange forespørgsler lige nu. Vent lidt, og prøv igen.',
};
/**
 * When Bilinfo's authorization service does not issue an access token (400, 401 or 403 from the token endpoint):
 * the client id or secret is wrong, or the client was not registered for the scope the service needs.
 */
export const TOKEN_REFUSED_HINT =
  'Bilinfo gav ikke adgang med det klient-id og den hemmelighed, forbindelsen er sat op med. Enten er de forkerte, eller også dækker aftalen med Bilinfo ikke denne tjeneste.';
/** For the statuses a server answers with when it is the one in trouble. */
const SERVER_ERROR_HINT = 'Bilinfo har problemer lige nu. Prøv igen om lidt.';

/** The first sentence of every HTTP error, also used alone in the audit log. */
export function httpStatusText(status: number): string {
  return `Bilinfo svarede med en fejl (HTTP ${status}).`;
}

/**
 * An HTTP error from the upstream API. It keeps the status, the parsed
 * Retry-After and the vendor's request id (only in the form such ids have,
 * see requestIdFrom), nothing from the response body: the message is our own.
 */
export class BilinfoHttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** Seconds to wait, parsed from Retry-After; undefined when absent or malformed. */
  readonly retryAfter?: string;
  /** The vendor's own id for the request, when a response header gives one as a UUID or hex id. */
  readonly requestId?: string;

  constructor(input: { status: number; url: string; retryAfter?: string; requestId?: string; hint?: string }) {
    super(httpErrorMessage(input.status, input.retryAfter, input.hint));
    this.name = 'BilinfoHttpError';
    this.status = input.status;
    this.url = describeUrl(input.url);
    const retryMs = parseRetryAfterMs(input.retryAfter);
    this.retryAfter = retryMs === undefined ? undefined : String(Math.ceil(retryMs / 1000));
    this.requestId = vendorRequestId(input.requestId);
  }
}

/**
 * Response headers that carry the vendor's own id for a request, most specific first. Add the vendor's documented
 * header in front when it has one.
 */
export const REQUEST_ID_HEADERS: readonly string[] = [
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'correlation-id',
  'x-ms-request-id',
  'x-amzn-requestid',
];

/**
 * A hex id: one run of hex digits, or groups of at least four hex digits joined by single hyphens (a UUID is one),
 * 8 to 64 characters in all. A name, a sentence or an e-mail address never fits.
 */
const REQUEST_ID_FORM = /^[0-9A-Fa-f]{4,}(?:-[0-9A-Fa-f]{4,})*$/;
/** Six digits and four more: the shape of a Danish personal number. An id that holds it is dropped. */
const PERSONAL_NUMBER_SHAPE = /\d{6}-?\d{4}/;

/**
 * The vendor's request id, only in the form such ids have (a UUID or a hex id of 8 to 64 characters), or
 * undefined. Anything else, and an id that holds the shape of a personal number, is dropped: the value comes from
 * the vendor and is kept only when it cannot be text.
 */
export function vendorRequestId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length >= 8 && id.length <= 64 && REQUEST_ID_FORM.test(id) && !PERSONAL_NUMBER_SHAPE.test(id) ? id : undefined;
}

/** The vendor's request id from the first of REQUEST_ID_HEADERS a response has in the right form, or undefined. */
export function requestIdFrom(headers: Headers, names: readonly string[] = REQUEST_ID_HEADERS): string | undefined {
  for (const name of names) {
    const id = vendorRequestId(headers.get(name));
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Metadata about a failed call, for a host that counts failures: the HTTP status the upstream API answered with
 * and its request id. Never the response body, the vendor's error code or message, or the input.
 */
export interface FailureMetadata {
  /** The HTTP status of the upstream API's answer (100-599). */
  httpStatus: number;
  /** The vendor's own id for the request, as a UUID or hex id only. */
  requestId?: string;
}

/**
 * A redirect the upstream API answered with, refused by the client. The message is our own (method and status,
 * never the Location, which is the vendor's text); the status and request id are kept for failureMetadata.
 */
export class UpstreamRedirectError extends Error {
  readonly status: number;
  /** The vendor's own id for the request, when a response header gives one as a UUID or hex id. */
  readonly requestId?: string;

  constructor(message: string, input: { status: number; requestId?: string }) {
    super(message);
    this.name = 'UpstreamRedirectError';
    this.status = input.status;
    this.requestId = vendorRequestId(input.requestId);
  }
}

/**
 * The failure metadata of an error: an HTTP error from the upstream API, or a redirect it answered with that was
 * refused, gives its status and request id.
 */
export function failureMetadata(error: unknown): FailureMetadata | undefined {
  if (!(error instanceof BilinfoHttpError) && !(error instanceof UpstreamRedirectError)) return undefined;
  const status = error.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const requestId = vendorRequestId(error.requestId);
  return requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId };
}

/**
 * The whole text of an HTTP error: status, our hint, and a parsed Retry-After in seconds. `hint` is a fixed text of
 * ours that replaces the general hint for the status, where the caller knows more (the token endpoint).
 */
export function httpErrorMessage(status: number, retryAfter?: string, hint?: string): string {
  const retryMs = parseRetryAfterMs(retryAfter);
  return [
    httpStatusText(status),
    hint ?? (Object.hasOwn(STATUS_HINTS, status) ? STATUS_HINTS[status] : status >= 500 && status <= 599 ? SERVER_ERROR_HINT : undefined),
    retryMs === undefined ? undefined : `Bilinfo beder om at vente ${Math.ceil(retryMs / 1000)} sekunder.`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function formatUnknownError(error: unknown, redactor?: SecretRedactor): string {
  if (error instanceof Error) {
    return redactSecrets(error.message, redactor);
  }
  return redactSecrets(String(error), redactor);
}

/**
 * Redact with an instance's redactor. Without one, only the credential-shaped
 * patterns are applied: no secret values are known outside an instance.
 */
export function redactSecrets(value: string, redactor?: SecretRedactor): string {
  return redactor ? redactor.redact(value) : applyPatterns(value, BASE_PATTERNS);
}

/** Origin and path of a URL, without query string or fragment (which may carry signatures). */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/**
 * Copy of a JSON-like value with every string, object keys included, passed
 * through redactSecrets, and every number, boolean or bigint whose string form
 * would be redacted replaced by the string "‹redacted›" (so the copy still
 * serialises to valid JSON). Redact a value with this before it is serialised:
 * a serialised secret is escaped, and the escaped form is easy to miss.
 * Anything nested deeper than MAX_REDACT_DEPTH is replaced, never passed on,
 * so a deep value cannot exhaust the stack when the copy is serialised.
 */
export function redactDeep(value: unknown, redactor?: SecretRedactor, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactSecrets(value, redactor);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    const text = String(value);
    if (redactSecrets(text, redactor) !== text) return '‹redacted›';
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    // A Date and the like: redact what JSON.stringify would write.
    return redactDeep(json.call(value), redactor, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, redactor, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redactSecrets(key, redactor),
      redactDeep(entry, redactor, depth + 1),
    ]),
  );
}

/** IMF-fixdate, the HTTP date format used by Retry-After. */
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a Retry-After header (delay in seconds or an HTTP date) into
 * milliseconds from `now`. Returns undefined when absent, malformed, zero or
 * in the past, so callers fall back to their own backoff.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms > 0 && Number.isSafeInteger(ms) ? ms : undefined;
  }
  if (!HTTP_DATE.test(trimmed)) {
    return undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date) || date <= now) {
    return undefined;
  }
  return date - now;
}
