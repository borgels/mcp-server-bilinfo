// Secrets (src/secrets.ts): the corpus of our own texts is up to date, and it decides which secrets can be told from
// ordinary text. No secret is refused: one that cannot be told apart is simply not looked for.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SecretRedactor } from '../src/errors.js';
import { FIXED_CORPUS } from '../src/fixed-corpus.generated.js';
import { maskedText, MIN_SECRET_LENGTH, recognisedByValue, sealedError } from '../src/secrets.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('secrets', () => {
  it('has a corpus that lists every string literal in src/', () => {
    // Exits 1, and so throws, when a text was added or changed without regenerating the corpus.
    execFileSync(process.execPath, ['scripts/fixed-corpus.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
    expect(FIXED_CORPUS.length).toBeGreaterThan(20);
  });

  it('recognises a secret by its value when it is long enough and not a text of our own', () => {
    expect(recognisedByValue('Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU')).toBe(true);
    expect(recognisedByValue('med mellemrum 1234')).toBe(true);
    expect(recognisedByValue('blåbærgrød')).toBe(true);
    expect(recognisedByValue('Bilinfo2026')).toBe(true);
    expect(recognisedByValue('Zq7pX2vK'.slice(0, MIN_SECRET_LENGTH - 1))).toBe(false);
    expect(recognisedByValue(undefined)).toBe(false);
    for (const text of FIXED_CORPUS.filter(entry => entry.length >= MIN_SECRET_LENGTH).slice(0, 50)) {
      expect(recognisedByValue(text), text).toBe(false);
      // A text of ours with something added is no longer a text of ours.
      expect(recognisedByValue(`${text}-Zq7pX2vK`), text).toBe(true);
    }
  });

  it('redacts whole values only, in their raw, URL-encoded and JSON-escaped forms', () => {
    const secret = 'kode "med" mellemrum æøå';
    const redactor = new SecretRedactor().addSecret(secret).addSecret('kort').addSecret('Bilinfo svarede med en fejl (HTTP ');
    expect(redactor.hasSecret(secret)).toBe(true);
    expect(redactor.hasSecret('kort')).toBe(false);
    for (const form of [secret, encodeURIComponent(secret), JSON.stringify(secret)]) {
      const text = `før ${form} efter`;
      expect(redactor.matches(text), form).toBe(true);
      expect(redactor.redact(text), form).not.toContain('mellemrum');
    }
    // A piece of the secret is an ordinary word and stays.
    expect(redactor.redact('en kode med mellemrum')).toBe('en kode med mellemrum');
    expect(redactor.redact('kort og godt')).toBe('kort og godt');
    expect(redactor.redact('Bilinfo svarede med en fejl (HTTP 500).')).toBe('Bilinfo svarede med en fejl (HTTP 500).');
  });

  it('masks a secret in an error in final form, and leaves ordinary text alone', () => {
    expect(maskedText('før Zq7pX2vK9mWb efter', 'Zq7pX2vK9mWb')).toBe('før … efter');
    expect(maskedText('før kort efter', 'kort')).toBe('før kort efter');
    const error = sealedError(new Error('failed for Zq7pX2vK9mWb', { cause: new Error('inner') }), 'Zq7pX2vK9mWb', undefined);
    expect(error.message).toBe('failed for …');
    expect(error.stack).toBe('Error: failed for …');
    expect(error.cause).toBeUndefined();
  });
});
