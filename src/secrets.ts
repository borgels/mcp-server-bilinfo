/**
 * The secrets of an instance, and the check every output passes as it leaves
 * (the sink check).
 *
 * No credential is refused for its form. Bilinfo issues the user name, the
 * password, the client id and the client secret, and whatever it issues must
 * work here: short, with spaces, with æ, ø and å, or holding words that also
 * stand in our own texts. The only form checks left are the ones the
 * protocol itself sets (src/bilinfo/client.ts, basicCredentials).
 *
 * The guarantee: nothing that leaves a gateway (a result, an error, an audit
 * record or line) contains a secret the instance can recognise by its value.
 * It holds at the sink: every output is checked in its final form, and one
 * that holds such a secret is replaced by a fixed fallback.
 *
 * A secret is recognised by its value when it has MIN_SECRET_LENGTH
 * characters or more and does not occur in one of our own fixed texts
 * (FIXED_CORPUS, every string literal in src/). A shorter one, or one that
 * is a word of ours, cannot be told from ordinary text: looking for it would
 * blank out normal words in every answer, and finding it would say nothing.
 * Such a secret is still never written by us anywhere: credentials only go
 * into the request header, and nothing the vendor answers is quoted in an
 * error.
 *
 * Only whole values are looked for, not pieces of them. A piece of a
 * password is often an ordinary word (a car make, a season, a town), and a
 * rule that blanks such words out of a dealer's answers would make the
 * password unusable.
 */
import { FIXED_CORPUS } from './fixed-corpus.generated.js';

/** Secrets shorter than this are not looked for by value (too likely to be normal text). */
export const MIN_SECRET_LENGTH = 8;
/** Values nested deeper than this cannot be checked, and count as leaking. */
const MAX_VISIBLE_DEPTH = 256;

let ownTexts: string | undefined;

/** Whether a secret can be told from ordinary text: long enough, and not a text of our own. */
export function recognisedByValue(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) {
    return false;
  }
  ownTexts ??= FIXED_CORPUS.join('\u0000');
  return !ownTexts.includes(value);
}

/** A text with every occurrence of the secret masked as "…" (when the secret is recognised by its value). */
export function maskedText(text: string, value: unknown): string {
  return recognisedByValue(value) ? text.split(value).join('…') : text;
}

/**
 * Every text a host can see of a value: its JSON text, and every string,
 * object key and number in it as it is (JSON escapes quotes and
 * backslashes, so a secret holding one is looked for in the raw strings too).
 * Throws when the value cannot be serialised or is too deep.
 */
export function visibleTexts(value: unknown): string[] {
  const texts: string[] = [];
  const json = JSON.stringify(value);
  if (json !== undefined) texts.push(json);
  const visit = (entry: unknown, depth: number): void => {
    if (depth > MAX_VISIBLE_DEPTH) throw new Error('too deep');
    if (entry instanceof Error) {
      // Not enumerable, so not in the JSON text: read on their own.
      texts.push(String(entry.name), String(entry.message), String(entry.stack ?? ''));
    }
    if (typeof entry === 'string') {
      texts.push(entry);
    } else if (typeof entry === 'number' || typeof entry === 'bigint' || typeof entry === 'boolean') {
      texts.push(String(entry));
    } else if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
    } else if (entry !== null && typeof entry === 'object') {
      for (const [key, item] of Object.entries(entry)) {
        texts.push(key);
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
  return texts;
}

/** Something that knows an instance's secrets: whether a text holds one of them. */
export interface LeakMatcher {
  matches(text: string): boolean;
}

/** The sink check: whether any text a host can see of `value` holds a secret. */
export function leaksSecret(value: unknown, matcher: LeakMatcher): boolean {
  let texts: string[];
  try {
    texts = visibleTexts(value);
  } catch {
    // What cannot be checked does not leave.
    return true;
  }
  return texts.some(text => matcher.matches(text));
}

/**
 * An error in final form, as it leaves a gateway: no `cause`, a `stack` set
 * to `${name}: ${message}` (no frames, paths or function names), and its
 * name, message and stack masked against every given secret. Build a fresh
 * error, then pass it through here.
 */
export function sealedError<E extends Error>(error: E, ...secrets: Array<string | undefined>): E {
  delete (error as { cause?: unknown }).cause;
  let name = String(error.name);
  let message = String(error.message);
  for (const secret of secrets) {
    name = maskedText(name, secret);
    message = maskedText(message, secret);
  }
  const stack = `${name}: ${message}`;
  for (const [key, value] of [['name', name], ['message', message], ['stack', stack]] as const) {
    Object.defineProperty(error, key, { value, writable: true, configurable: true, enumerable: false });
  }
  return error;
}
