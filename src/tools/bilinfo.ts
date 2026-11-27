import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  WRITE_TOOL_ANNOTATIONS,
} from '../bilinfo/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../bilinfo/audit.js';
import { APPLICATION_STATUS_PATH, reportApplicationStatus } from '../bilinfo/case-plugin.js';
import { readOnlyClient, type BilinfoService, type UpstreamClient } from '../bilinfo/client.js';
import { DEALERS_BY_CVR_PATH, findDealers, listUsers, USERS_BY_DEALER_PATH } from '../bilinfo/lookups.js';
import type { ActAs } from '../act-as.js';
import { formatUnknownError, type SecretRedactor } from '../errors.js';
import {
  danishToday,
  DEFAULT_PAGE_SIZE,
  EXPORT_PATH,
  fetchVehicles,
  getVehicle,
  listVehicles,
  MAX_PAGE_SIZE,
  stockOverview,
} from '../bilinfo/vehicles.js';
import { checkInputPolicy, checkToolPolicy, isToolDisabled, redactInScope, runInCallScope, validatePolicyConfig } from '../bilinfo/policy.js';

/** A listing's id (VehicleId) is a GUID. */
const vehicleIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'Brug bilens vehicleId fra listen over biler.');
const wordSchema = z.string().trim().min(1).max(100);
const priceSchema = z.number().int().min(0).max(1_000_000_000);
const yearSchema = z.number().int().min(1900).max(2100);

/**
 * The status of one part of an application. Bilinfo documents the numbers (Case Plugin document, tables 6-3 and
 * 6-4) and shows the two texts in its example; it does not say that they are required.
 */
const statusShape = (max: number) =>
  z.strictObject({
    status: z.number().int().min(0).max(max).describe('Status som tal, se værktøjets beskrivelse.'),
    statusText: z.string().trim().min(1).max(200).optional().describe('Status med ord, som forhandleren ser den, fx Under behandling.'),
    providerName: z.string().trim().min(1).max(200).optional().describe('Navnet på selskabet bag tilbuddet.'),
  });

/** The one request the three vehicle tools make: the Listing API has no other. */
const READ_EXPORT: UpstreamOperation = { access: 'read', method: 'GET', service: 'listing', path: EXPORT_PATH };

type ToolAnnotations = typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;

/**
 * One upstream request a tool may make: `read` or `write`, the HTTP method,
 * the Bilinfo service and the path template relative to that service's base
 * URL (`{name}` marks a caller-supplied segment). Published in the gateway tool catalog so a host
 * can see what each tool touches; keep it in step with the handler.
 */
export interface UpstreamOperation {
  access: 'read' | 'write';
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  service: Exclude<BilinfoService, 'token'>;
  path: string;
}

/** A client that carries the redactor of its instance (BilinfoClient does). */
export interface RedactingClient extends UpstreamClient {
  readonly redactor: SecretRedactor;
}

/**
 * One definition per tool, shared by the MCP server and the gateway entry
 * point: same input schema, same handler, same policy and audit path.
 */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (`bilinfo_*`). The gateway exposes it without the prefix. */
  name: string;
  title: string;
  description: string;
  inputShape: S;
  /** Strict object built from inputShape: unknown arguments are rejected. */
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Whether the result carries upstream content (vs. server metadata). */
  returnsUpstreamContent: boolean;
  /** Short human-readable summary used by the gateway result text. */
  summary: string;
  /** Every upstream request the handler may make. */
  upstream: readonly UpstreamOperation[];
  /**
   * True when the tool can read more than its name says: anything in the
   * system, chosen by the input (a generic get-by-path, a raw query).
   * Published as `broad` in the gateway catalog, so a host that grants tools
   * per role gives it only to roles that may read everything. Default false.
   */
  broad?: boolean;
  /** A read tool is handed a client that can only read (readOnlyClient), whatever its handler tries. */
  handler: (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(definition: Omit<ToolDefinition<S>, 'inputSchema'>): ToolDefinition {
  const description = definition.returnsUpstreamContent
    ? `${definition.description} ${UNTRUSTED_CONTENT_NOTE}`
    : definition.description;
  return {
    ...definition,
    description,
    inputSchema: z.strictObject(definition.inputShape),
  } as unknown as ToolDefinition;
}

export const BILINFO_TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'bilinfo_list_vehicles',
    title: 'Biler til salg (Bilinfo)',
    description:
      'Viser forhandlerens biler til salg i Bilinfo, én linje pr. annonce: mærke, model, variant, årgang, kilometertal, ' +
      'drivmiddel, pris, dato for oprettelse i Bilinfo og antal dage siden. Kan afgrænses på mærke, model, drivmiddel, ' +
      'pris, årgang og fri tekst, og sorteres efter pris eller efter, hvor længe bilen har stået. ' +
      'Prisen er den annoncerede pris: kontantpris (RetailPrice), pris uden registreringsafgift (RetailPriceWithoutTax) ' +
      'eller leasingpris (Leasing); ved CallForPrice er der ingen pris. En bil, der både er til salg og til leasing, ' +
      'har to annoncer. Svaret er delt i sider; hent flere med page. Brug vehicleId til at slå en bil op.',
    inputShape: {
      make: wordSchema.optional().describe('Mærke eller en del af det, fx Audi eller Mercedes.'),
      model: wordSchema.optional().describe('Model eller en del af den, fx Golf.'),
      fuel: wordSchema.optional().describe('Drivmiddel, fx Benzin, Diesel eller El. En hybrid har to drivmidler og findes under begge.'),
      priceMin: priceSchema.optional().describe('Laveste pris i kroner. Gælder kun biler med en købspris; leasingannoncer udelades.'),
      priceMax: priceSchema.optional().describe('Højeste pris i kroner. Gælder kun biler med en købspris; leasingannoncer udelades.'),
      yearMin: yearSchema.optional().describe('Tidligste årgang, fx 2019.'),
      yearMax: yearSchema.optional().describe('Seneste årgang, fx 2022.'),
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe('Fri tekst. Alle ord skal findes i bilens mærke, model, variant, type, farve, drivmiddel, udstyr eller beskrivelse.'),
      sort: z
        .enum(['longest_listed', 'newest_listed', 'price_low', 'price_high'])
        .optional()
        .describe(
          'Rækkefølge: longest_listed (har stået længst først), newest_listed (nyeste først), price_low (billigste først) ' +
            'eller price_high (dyreste først). Uden sort bruges Bilinfos egen rækkefølge.',
        ),
      page: z.number().int().min(1).max(10_000).optional().describe('Sidenummer, fra 1. Standard er 1.'),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .optional()
        .describe(`Antal biler pr. side, højst ${MAX_PAGE_SIZE}. Standard er ${DEFAULT_PAGE_SIZE}.`),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Biler til salg er hentet fra Bilinfo.',
    upstream: [READ_EXPORT],
    handler: async (client, input) => listVehicles(await fetchVehicles(client), input, danishToday()),
  }),
  defineTool({
    name: 'bilinfo_get_vehicle',
    title: 'Én bil med alle oplysninger (Bilinfo)',
    description:
      'Viser alt, hvad Bilinfo har om én bil til salg: priser, kilometertal, første registrering, udstyr, beskrivelse, ' +
      'billeder, afgifter, eventuelle leasingvilkår og forhandlerens kontaktoplysninger. ' +
      'Har samme bil flere annoncer, fx én til salg og én til leasing, nævnes de andre. ' +
      'Bilen findes med vehicleId fra listen over biler; en solgt eller fjernet bil kan ikke slås op.',
    inputShape: {
      vehicleId: vehicleIdSchema.describe('Bilens vehicleId fra listen over biler.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Bilen er hentet fra Bilinfo.',
    upstream: [READ_EXPORT],
    handler: async (client, input) => getVehicle(await fetchVehicles(client), input.vehicleId, danishToday()),
  }),
  defineTool({
    name: 'bilinfo_stock_overview',
    title: 'Overblik over lageret (Bilinfo)',
    description:
      'Giver et overblik over forhandlerens biler til salg i Bilinfo: antal annoncer og antal biler, samlet og ' +
      'gennemsnitlig udbudspris, fordeling på mærker og fordeling efter, hvor længe bilerne har stået. ' +
      'Udbudsprisen lægges kun sammen for biler med en købspris, og kontantpriser og priser uden registreringsafgift ' +
      'holdes hver for sig; leasingannoncer tælles, men lægges ikke sammen. ' +
      'Alderen regnes fra den dag, bilen blev oprettet i Bilinfo, som ikke altid er den dag, bilen kom på lager.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Overblikket er lavet ud fra bilerne i Bilinfo.',
    upstream: [READ_EXPORT],
    handler: async client => stockOverview(await fetchVehicles(client), danishToday()),
  }),
  defineTool({
    name: 'bilinfo_find_dealer',
    title: 'Find forhandler på CVR-nummer (Bilinfo)',
    description:
      'Slår en forhandler op i Bilinfo på CVR-nummeret og viser navn, adresse, telefon, e-mail og forhandlerens id i ' +
      'Bilinfo. Har virksomheden flere afdelinger, kommer der én linje pr. afdeling. ' +
      'Kræver, at forbindelsen har adgang til Bilinfos forhandleropslag.',
    inputShape: {
      cvr: z.string().trim().min(1).max(20).describe('Virksomhedens CVR-nummer, fx 12345678.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Forhandleren er slået op i Bilinfo.',
    upstream: [{ access: 'read', method: 'GET', service: 'dealerLookup', path: DEALERS_BY_CVR_PATH }],
    handler: async (client, input) => findDealers(client, input.cvr),
  }),
  defineTool({
    name: 'bilinfo_list_users',
    title: 'Forhandlerens brugere (Bilinfo)',
    description:
      'Viser brugerne hos forhandleren i Bilinfo, typisk sælgerne: navn, e-mail, adresse og mobilnummer. ' +
      'Det er altid den forhandler, forbindelsen er sat op til. ' +
      'Kræver, at forbindelsen har adgang til Bilinfos brugeropslag.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Brugerne er hentet fra Bilinfo.',
    upstream: [{ access: 'read', method: 'GET', service: 'userLookup', path: USERS_BY_DEALER_PATH }],
    handler: async client => listUsers(client),
  }),
  defineTool({
    name: 'bilinfo_report_application_status',
    title: 'Meld status på en ansøgning (Bilinfo)',
    description:
      'Melder status på en ansøgning om lån, leasing, forsikring eller vejhjælp tilbage til sagen i Bilinfo, så ' +
      'forhandleren kan følge den. Er kun for finansierings- og forsikringsselskaber, der har et sagsmodul i Bilinfo. ' +
      'Status for lån og leasing: 1 under behandling, 2 effektueret, 3 godkendt, 4 afvist, 5 annulleret, ' +
      '6 forhåndsgodkendt. Status for forsikring og vejhjælp: 0 ikke sendt, 1 sendt. ' +
      'Angiv kun de dele, ansøgningen omfatter. Ændringen sker med det samme i Bilinfo og erstatter den status, der stod før.',
    inputShape: {
      reference: z.string().trim().min(1).max(200).describe('Sagens reference, som Bilinfo gav sagsmodulet, da sagen blev åbnet.'),
      loan: statusShape(6).optional().describe('Status for lån.'),
      leasing: statusShape(6).optional().describe('Status for leasing.'),
      insurance: statusShape(1).optional().describe('Status for forsikring.'),
      roadSideAssistance: statusShape(1).optional().describe('Status for vejhjælp.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Status er meldt til Bilinfo.',
    upstream: [{ access: 'write', method: 'PUT', service: 'casePlugin', path: APPLICATION_STATUS_PATH }],
    handler: async (client, input) => reportApplicationStatus(client, input),
  }),
];

export function findTool(name: string): ToolDefinition | undefined {
  return BILINFO_TOOLS.find(tool => tool.name === name);
}

/** Validate the tool policy environment. Cheap; runs for every server instance. */
export function validateToolConfig(): void {
  validatePolicyConfig(BILINFO_TOOLS.map(tool => tool.name));
}

/**
 * Startup checks for entry points (transports, gateway): tool policy plus a
 * writable audit log. The audit check is not repeated per HTTP request, so
 * read tools keep working if the log becomes unwritable later; write tools
 * then fail closed when their start record cannot be written.
 */
export function validateStartupConfig(): void {
  validateToolConfig();
  assertAuditLogWritable();
}

/** Tools enabled on this instance (BILINFO_DISABLED_TOOLS removes them entirely). */
export function enabledTools(): ToolDefinition[] {
  return BILINFO_TOOLS.filter(tool => !isToolDisabled(tool.name));
}

export function registerTools(server: McpServer, client: RedactingClient): void {
  validateToolConfig();
  for (const tool of enabledTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: Record<string, unknown>) => {
        try {
          // In a scope with this server's redactor, like a gateway call: audit records and context are redacted.
          return mcpToolResult(tool, await runInCallScope({ redactor: client.redactor }, () => executeTool(tool, client, input)));
        } catch (error) {
          // Central redaction with this instance's secrets: no error text reaches the client unredacted.
          return {
            isError: true,
            content: [{ type: 'text' as const, text: formatUnknownError(error, client.redactor) }],
          };
        }
      },
    );
  }
}

/** Optional call context supplied by an embedding host. */
export interface CallContext {
  /** Caller identity, recorded in audit events. */
  caller?: string;
  /** Request id to reuse in audit events, for correlation with the host's own log. */
  requestId?: string;
  /**
   * Gateway only: the person to act as, as the host verified them (src/act-as.ts). Never written to audit events.
   * Without it the call runs as the key's own user.
   */
  actAs?: ActAs;
}

function contextString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Redacted before it is cut short: a cut key would no longer match the redactor.
  const trimmed = redactInScope(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Normalise a host-supplied context; malformed values are ignored. */
export function normaliseCallContext(context: unknown): { requestId: string; caller?: string } {
  const value = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  return {
    requestId: contextString(value.requestId, 200) ?? newRequestId(),
    caller: contextString(value.caller, 320),
  };
}

/**
 * Run one validated tool call through the instance policy and the audit
 * log. Used by both the MCP server and the gateway entry point.
 */
export async function executeTool(
  tool: ToolDefinition,
  client: RedactingClient,
  input: Record<string, unknown>,
  context?: CallContext,
): Promise<unknown> {
  const { requestId, caller } = normaliseCallContext(context);
  const target = auditTarget(input);
  const { redactor } = client;

  const policy = checkToolPolicy(tool.name, tool.annotations.readOnlyHint);
  const inputPolicy = policy.allowed ? checkInputPolicy(tool.name, input) : policy;
  if (!inputPolicy.allowed) {
    await writeAuditEvent(
      { requestId, tool: tool.name, caller, action: 'policy_denied', target, reason: inputPolicy.reason },
      { redactor },
    );
    throw new Error(inputPolicy.reason);
  }

  // Write tools fail closed: no write runs without its start record.
  await writeAuditEvent(
    { requestId, tool: tool.name, caller, action: 'start', target, reason: policy.reason },
    { required: !tool.annotations.readOnlyHint, redactor },
  );
  const startedAt = performance.now();

  try {
    // A read tool gets a view of the client that cannot send a change.
    const handlerClient = tool.annotations.readOnlyHint ? readOnlyClient(client, tool.name) : client;
    const result = await tool.handler(handlerClient, input as never);
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'finish',
      target,
      status: 'ok',
      durationMs: Math.round(performance.now() - startedAt),
    }, { redactor });
    return result;
  } catch (error) {
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'error',
      target,
      status: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      error,
    }, { redactor });
    throw error;
  }
}

const MAX_REJECTED_FIELDS = 20;
const MAX_REJECTED_FIELD_LENGTH = 64;

/** Audit a call rejected before execution (unknown tool or invalid input); field names only. */
export async function auditRejectedCall(
  toolName: string,
  input: unknown,
  reason: string,
  context?: unknown,
): Promise<void> {
  const { requestId, caller } = normaliseCallContext(context);
  const fields =
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.keys(input)
          .sort()
          .slice(0, MAX_REJECTED_FIELDS)
          .map(key => redactInScope(key).slice(0, MAX_REJECTED_FIELD_LENGTH))
      : [];
  await writeAuditEvent({
    requestId,
    tool: redactInScope(toolName).slice(0, 100),
    caller,
    action: 'rejected',
    target: { fields },
    reason: redactInScope(reason).slice(0, 200),
  });
}

/** Compact JSON (no pretty-printing): indentation only costs tokens. */
export function compactJson(data: unknown): string {
  return JSON.stringify(data ?? null);
}

function mcpToolResult(tool: ToolDefinition, data: unknown) {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: compactJson(data) }];
  if (tool.returnsUpstreamContent) {
    content.push({ type: 'text', text: UNTRUSTED_RESULT_NOTE });
  }
  return { content };
}
