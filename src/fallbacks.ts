/**
 * The fixed outputs of the sink check (src/secrets.ts): what leaves a
 * gateway instead of an output that still holds a secret after redaction. A
 * small closed set of our own texts: a secret that occurs in one of them is
 * ordinary text and is not looked for.
 */

/** The text of a result that was withheld. In Danish: the person who asked reads it. */
export const RESULT_WITHHELD = 'Svaret er tilbageholdt, fordi det indeholdt tekst, der svarer til adgangskoden eller hemmeligheden for denne forbindelse.';

/** The result a host gets instead of one that held a secret. */
export function withheldResult(): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  return { isError: true, content: [{ type: 'text', text: RESULT_WITHHELD }] };
}

/** The audit record written instead of one that held a secret. */
export function withheldAuditRecord(): Record<string, unknown> {
  return { auditRecord: 'withheld' };
}

/** The stderr line written instead of one that held a secret. */
export const STDERR_WITHHELD = '[bilinfo-mcp] audit log write failed.';

/** Names a host may log with a refusal: the error classes a gateway throws. */
const ERROR_NAMES = ['ConfigError', 'Error'];

/** Every fixed output, as a host or a log sees it. */
export function fixedOutputs(): unknown[] {
  return [
    withheldResult(),
    withheldAuditRecord(),
    `${JSON.stringify(withheldAuditRecord())}\n`,
    `${STDERR_WITHHELD}\n`,
    ...ERROR_NAMES,
  ];
}
