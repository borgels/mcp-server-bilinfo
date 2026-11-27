/**
 * Act as a person (gateway only): the shared "act as" context a host gives a
 * call, so a server can make the call's changes in the person's own name in
 * the upstream system, instead of the key's own user.
 *
 * The host has verified the person (signed in, email confirmed) and passes
 * `actAs: { email, name? }` in the call context. The server finds the
 * person's user in the system by that email and puts it on the request (a
 * header such as Zammad's `From`, or a user or employee field), as the
 * vendor documents it. The rules every server keeps:
 *
 * - **No fallback for a change.** When the host gave `actAs` and the person
 *   has no user in the system (or more than one, or the key may not act for
 *   others), the change is not sent: the handler throws ActAsRefusedError and
 *   the gateway answers with `actAsRefused` and a fixed text. A change is
 *   never made as the key's own user instead.
 * - **Reads are the server's choice, written down per system.** A read may go
 *   as the key's own user when that is harmless; the server's README says
 *   which.
 * - **The server adds the email nowhere.** It is only sent upstream to find
 *   the user. The server never writes it to its audit (the audit has the
 *   host's `caller`, which the host chooses) and never puts it in a text or
 *   field of its own. Data the system returns is passed on as it is.
 * - **A malformed `actAs` refuses the call.** It is never dropped silently,
 *   since that would make the call as the key's own user. Only an absent
 *   (`undefined`) `actAs` means "no person"; `null` is refused too.
 *
 * Without `actAs` a call runs as it always has: as the key's own user.
 *
 * Bilinfo: the Listing API has no users. An account's credentials read the
 * account's vehicles, and there is no one to act as. A call with a valid
 * `actAs` is therefore a plain read with the account's credentials, and this
 * server never sends the email anywhere. A malformed `actAs` is still
 * refused, as on every server, so a host's mistake does not pass unnoticed.
 */

/** The person a call is made for, as the host verified them. */
export interface ActAs {
  /** The person's verified email, compared case-insensitively. */
  readonly email: string;
  /** The person's name, when the system needs it to match or create a user. */
  readonly name?: string;
}

/** Why a call was not made as the person. */
export type ActAsRefusal = 'invalid' | 'no_user' | 'not_permitted';

export const ACT_AS_REFUSALS: readonly ActAsRefusal[] = Object.freeze(['invalid', 'no_user', 'not_permitted']);

/** Our own fixed texts for a refusal; never the email, never the vendor's text. */
export const ACT_AS_TEXTS: Readonly<Record<ActAsRefusal, string>> = Object.freeze({
  invalid: 'Afvist: personen, der handles på vegne af, er ikke angivet med en gyldig e-mailadresse. Der blev ikke sendt noget.',
  no_user: 'Afvist: personen har ikke netop én aktiv bruger i systemet med den e-mailadresse. Der blev ikke ændret noget.',
  not_permitted: 'Afvist: forbindelsen må ikke handle på vegne af en anden bruger i systemet. Der blev ikke ændret noget.',
});

/** Thrown by a handler (or the client) when a call cannot be made as the person. */
export class ActAsRefusedError extends Error {
  readonly refusal: ActAsRefusal;

  constructor(refusal: ActAsRefusal) {
    super(ACT_AS_TEXTS[refusal]);
    this.name = 'ActAsRefusedError';
    this.refusal = refusal;
  }
}

/** A local part of dot-separated atoms (no leading, trailing or doubled dot), then a domain of two labels or more. */
const ATOM = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+";
const EMAIL = new RegExp(`^${ATOM}(?:\\.${ATOM})*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`);

/**
 * The host's `actAs`, checked: undefined when the host gave none (undefined, not null), a frozen
 * `{ email, name? }` (email trimmed and lowercased, at most 254 characters;
 * name trimmed, 1-200 characters, no control characters) when it is usable,
 * and ActAsRefusedError('invalid') otherwise.
 */
export function normaliseActAs(value: unknown): Readonly<ActAs> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ActAsRefusedError('invalid');
  const { email, name } = value as Record<string, unknown>;
  if (typeof email !== 'string') throw new ActAsRefusedError('invalid');
  const address = email.trim().toLowerCase();
  if (address.length > 254 || address.indexOf('@') > 64 || !EMAIL.test(address)) throw new ActAsRefusedError('invalid');
  if (name === undefined) return Object.freeze({ email: address });
  if (typeof name !== 'string') throw new ActAsRefusedError('invalid');
  const shown = name.trim();
  if (shown.length < 1 || shown.length > 200 || /[\u0000-\u001f\u007f]/.test(shown)) throw new ActAsRefusedError('invalid');
  return Object.freeze({ email: address, name: shown });
}

/** The refusal on a result, as it must be after redaction: one of ACT_AS_REFUSALS, or nothing. */
export function actAsRefusalInForm(value: unknown): ActAsRefusal | undefined {
  return typeof value === 'string' && (ACT_AS_REFUSALS as readonly string[]).includes(value) ? (value as ActAsRefusal) : undefined;
}
