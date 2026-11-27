import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  WRITE_TOOL_ANNOTATIONS,
} from '../bilinfo/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../bilinfo/audit.js';
import {
  CAR_OPTION_KINDS,
  CAR_OPTION_PATHS,
  listCarOptions,
  SAVE_CAR_PATH,
  saveCar,
  SELL_CAR_PATH,
  sellCar,
  type SaveCarInput,
} from '../bilinfo/cars.js';
import { readOnlyClient, type BilinfoService, type UpstreamClient } from '../bilinfo/client.js';
import { LEAD_STATUSES, LIST_LEADS_PATH, listLeads, MAX_LEADS, UPDATE_LEAD_PATH, updateLead } from '../bilinfo/leads.js';
import { DRILL_DOWN_BY_NUMBER_PATH, DRILL_DOWN_PATH, findModel } from '../bilinfo/models.js';
import { ActAsRefusedError, type ActAs } from '../act-as.js';
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
import {
  checkInputPolicy,
  checkToolPolicy,
  currentActAs,
  isToolDisabled,
  redactInScope,
  runInCallScope,
  validatePolicyConfig,
} from '../bilinfo/policy.js';

/** A listing's id (VehicleId) is a GUID. */
const vehicleIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'Brug bilens vehicleId fra listen over biler.');
const wordSchema = z.string().trim().min(1).max(100);
const priceSchema = z.number().int().min(0).max(1_000_000_000);
const yearSchema = z.number().int().min(1900).max(2100);
/** An id in the Car API and the Model Catalog (variant, colour, upholstery, equipment) is a GUID. */
const guidSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'Brug et id fra Bilinfo.');
/** The dealer's own id for a car in the Car API: unique, and part of no path. */
const carIdSchema = z.string().trim().min(1).max(100);
/** An amount in kroner, as the Car API takes it (above zero and below 100,000,000 where it is checked). */
const moneySchema = z.number().min(0).max(100_000_000);
/** A calendar date as YYYY-MM-DD. */
const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Skriv datoen som ÅÅÅÅ-MM-DD.')
  .refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'Datoen findes ikke.');
/** A picture Bilinfo already has: an https address on bilinfo.net (Bilinfo's picture host). */
const pictureUrlSchema = z
  .string()
  .trim()
  .max(2_000)
  .refine(value => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return url.protocol === 'https:' && !url.username && !url.password && (host === 'bilinfo.net' || host.endsWith('.bilinfo.net'));
    } catch {
      return false;
    }
  }, 'Brug adressen på et billede, Bilinfo allerede har (https på bilinfo.net).');

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
    name: 'bilinfo_find_model',
    title: 'Slå en bilmodel op (Bilinfo)',
    description:
      'Slår en bil op i Bilinfos modelkatalog og giver de varianter, der passer, med deres id (variantId), tekst, ' +
      'hestekræfter, brændstof og nypris. Søg på nummerplade eller stelnummer (number), så finder Bilinfo varianterne ' +
      'til den registrerede bil, eller på mærke, model, årgang og drivmiddel, hvor svaret også viser de valg, der er ' +
      'tilbage på næste niveau. En bil i Bilinfo skal have variantId herfra, når den oprettes.',
    inputShape: {
      number: z.string().trim().min(2).max(20).optional().describe('Nummerplade eller stelnummer (VIN), fx AB12345.'),
      type: wordSchema.optional().describe('Køretøjstype, som Bilinfo skriver den, fx Personbil eller Varebil.'),
      make: wordSchema.optional().describe('Mærke, fx Skoda.'),
      model: wordSchema.optional().describe('Model, fx Octavia.'),
      year: yearSchema.optional().describe('Årgang, fx 2021.'),
      fuel: wordSchema.optional().describe('Drivmiddel, fx Benzin, Diesel eller El.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Modellen er slået op i Bilinfo.',
    upstream: [
      { access: 'read', method: 'GET', service: 'models', path: DRILL_DOWN_BY_NUMBER_PATH },
      { access: 'read', method: 'GET', service: 'models', path: DRILL_DOWN_PATH },
    ],
    handler: async (client, input) => findModel(client, input),
  }),
  defineTool({
    name: 'bilinfo_list_car_options',
    title: 'Farver, polstring og udstyr (Bilinfo)',
    description:
      'Viser en af Bilinfos lister med id og navn: farver (colors), polstring (upholstery), farver på polstring ' +
      '(upholsteryColors) eller ekstraudstyr (extraEquipment). En bil i Bilinfo bruger id herfra til farve, polstring ' +
      'og udstyr, når den oprettes eller rettes.',
    inputShape: {
      kind: z.enum(CAR_OPTION_KINDS).describe('Hvilken liste: colors, upholstery, upholsteryColors eller extraEquipment.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listen er hentet fra Bilinfo.',
    upstream: CAR_OPTION_KINDS.map(kind => ({ access: 'read' as const, method: 'GET' as const, service: 'cars' as const, path: CAR_OPTION_PATHS[kind] })),
    handler: async (client, input) => listCarOptions(client, input.kind),
  }),
  defineTool({
    name: 'bilinfo_list_leads',
    title: 'Kundehenvendelser (Bilinfo)',
    description:
      'Viser forhandlerens kundehenvendelser fra Bilbasen, Bilinfo og DBA: kundens navn, telefon, e-mail og besked, ' +
      'bilen, henvendelsen gælder, annoncen, sælgeren og hvornår den kom. De ældste kommer først, højst 200 ad gangen. ' +
      'Hent de næste ved at sende nextVersion fra svaret som sinceVersion. Henvendelserne er oplysninger om personer: ' +
      'brug dem kun til at følge op på henvendelsen.',
    inputShape: {
      sinceVersion: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Vis henvendelser, der er oprettet eller ændret efter denne version (nextVersion fra et tidligere svar). Standard er 0: fra den ældste.'),
      count: z.number().int().min(1).max(MAX_LEADS).optional().describe(`Højst så mange, 1-${MAX_LEADS}. Standard er ${MAX_LEADS}.`),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Kundehenvendelserne er hentet fra Bilinfo.',
    upstream: [{ access: 'read', method: 'GET', service: 'leads', path: LIST_LEADS_PATH }],
    handler: async (client, input) => listLeads(client, input),
  }),
  defineTool({
    name: 'bilinfo_update_lead',
    title: 'Ret status på en kundehenvendelse (Bilinfo)',
    description:
      'Sætter status på en kundehenvendelse i Bilinfo, fx at kunden er kontaktet, har prøvekørt, har fået et tilbud, ' +
      'har købt eller er tabt, og retter kundens kontaktoplysninger, når de angives. Status: New (ny), Contacted ' +
      '(kontaktet), TestDrive (prøvekørsel), Offer (tilbud), Sold (solgt), CaseCreated (sag oprettet), ' +
      'ContractNotePrinted (slutseddel udskrevet), ContractNoteSigned (slutseddel underskrevet), CarDelivered (bil ' +
      'udleveret) eller LeadLost (tabt). Ændringen sker med det samme i Bilinfo. Henvendelsen slettes aldrig.',
    inputShape: {
      leadId: z.string().trim().min(1).max(100).describe('Henvendelsens id fra listen over kundehenvendelser.'),
      status: z.enum(LEAD_STATUSES).describe('Den nye status.'),
      contact: z
        .strictObject({
          firstName: z.string().trim().min(1).max(50).optional().describe('Fornavn.'),
          lastName: z.string().trim().min(1).max(50).optional().describe('Efternavn.'),
          phone: z.string().trim().min(1).max(30).optional().describe('Telefonnummer.'),
          email: z.string().trim().min(3).max(60).optional().describe('E-mail.'),
          contactType: z.enum(['Private', 'Business']).optional().describe('Private (privat) eller Business (erhverv).'),
          companyName: z.string().trim().min(1).max(50).optional().describe('Firmanavn, hvis kunden er et firma.'),
          address: z.string().trim().min(1).max(200).optional().describe('Gade, husnummer og etage.'),
          zipCode: z.number().int().min(0).max(99_999).optional().describe('Postnummer.'),
          city: z.string().trim().min(1).max(100).optional().describe('By.'),
        })
        .optional()
        .describe('Kundens kontaktoplysninger, når de skal rettes. Udelad for kun at sætte status.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Kundehenvendelsen er opdateret i Bilinfo.',
    upstream: [{ access: 'write', method: 'PUT', service: 'leads', path: UPDATE_LEAD_PATH }],
    handler: async (client, input) => updateLead(client, input),
  }),
  defineTool({
    name: 'bilinfo_save_car',
    title: 'Opret eller ret en bil (Bilinfo)',
    description:
      'Opretter en bil hos forhandleren i Bilinfo, som annonceres på Bilbasen og DBA, eller retter en bil, forbindelsen ' +
      'har oprettet: pris, kilometertal, beskrivelse, udstyr, billeder, status og synlighed. Bilinfo sætter bilen til ' +
      'præcis det, der sendes, så en rettelse skal have alle bilens oplysninger med igen, ikke kun det, der ændres. ' +
      'Brug samme carId, når bilen rettes. variantId findes med opslag i modelkataloget, og farve, polstring og udstyr ' +
      'med listen over valgmuligheder. visibility Internal tager annoncen af Bilbasen og DBA, men bilen bliver i Bilinfo; ' +
      'External sætter den på igen. Billeder skal være adresser på billeder, Bilinfo allerede har. ' +
      'En bil, der er oprettet direkte i Bilinfo, kan ikke rettes herfra. Ændringen sker med det samme i Bilinfo.',
    inputShape: {
      carId: carIdSchema.describe('Bilens id hos forhandleren, fx lagernummeret. Samme id ved hver rettelse; det skal være entydigt.'),
      variantId: guidSchema.describe('Bilens variant fra modelkataloget (variantId).'),
      version: z
        .number()
        .int()
        .min(1)
        .max(2_147_483_647)
        .optional()
        .describe('Versionsnummer, højere end ved sidste ændring. Udelad det: så bruges tidspunktet, som altid er højere.'),
      mileage: z.number().int().min(0).max(3_000_000).describe('Kilometertal.'),
      isFactoryNew: z.boolean().optional().describe('true for en fabriksny bil (under 2.000 km og højst fire år fra første registrering).'),
      registrationDate: dateSchema.optional().describe('Første registrering, ÅÅÅÅ-MM-DD. Skal angives, når bilen ikke er fabriksny.'),
      registrationNumber: z.string().trim().max(7).optional().describe('Nummerplade, højst 7 tegn.'),
      vinNumber: z.string().trim().min(10).max(19).optional().describe('Stelnummer (VIN), 10-19 tegn.'),
      inspectionDate: dateSchema.optional().describe('Seneste syn, ÅÅÅÅ-MM-DD.'),
      productionDate: dateSchema.optional().describe('Produktionsdato, ÅÅÅÅ-MM-DD.'),
      cashPrice: moneySchema.optional().describe('Kontantpris i kroner med leveringsomkostninger. Mindst 15.000 kr. for en bil, der er yngre end syv år.'),
      priceWithoutTax: moneySchema.optional().describe('Pris uden registreringsafgift i kroner.'),
      leasing: z
        .strictObject({
          monthlyPayment: moneySchema.min(100).describe('Månedlig ydelse i kroner, mindst 100.'),
          audience: z.enum(['NotSpecified', 'Private', 'Business']).optional().describe('Private (privat) eller Business (erhverv).'),
          type: z.enum(['Operational', 'Financial']).optional().describe('Operational (operationel) eller Financial (finansiel).'),
          durationMonths: z.number().int().min(1).max(240).optional().describe('Løbetid i måneder.'),
          downPayment: moneySchema.optional().describe('Udbetaling i kroner.'),
          residualValue: moneySchema.optional().describe('Restværdi i kroner. Skal angives ved finansiel leasing.'),
          totalPayment: moneySchema.optional().describe('Samlet betaling i kroner, mindst 1.000.'),
          yearlyMileage: z.number().int().min(0).max(1_000_000).optional().describe('Kilometer pr. år.'),
          includesInsurance: z.boolean().optional().describe('true, når forsikring er med.'),
          serviceAndMaintenance: z
            .enum(['NotIncluded', 'IncludedWithTires', 'IncludedWithoutTires'])
            .optional()
            .describe('Service og vedligehold: NotIncluded, IncludedWithTires eller IncludedWithoutTires.'),
        })
        .optional()
        .describe('Leasingpris, når bilen også udbydes til leasing.'),
      vatOption: z.enum(['VatFree', 'NotVatFree']).optional().describe('NotVatFree: priserne er med moms. VatFree: uden moms.'),
      saleType: z
        .enum(['RetailSale', 'Consignment', 'Facilitated'])
        .optional()
        .describe('RetailSale (detailsalg, standard), Consignment (kommissionssalg) eller Facilitated (formidlingssalg).'),
      description: z.string().trim().max(4000).optional().describe('Beskrivelsen i annoncen, højst 4.000 tegn.'),
      pictures: z
        .array(pictureUrlSchema)
        .max(24)
        .optional()
        .describe('Adresser på bilens billeder hos Bilinfo, i rækkefølge, højst 24. Udelades de, har bilen ingen billeder efter ændringen.'),
      extraEquipment: z.array(guidSchema).max(200).optional().describe('Id på ekstraudstyr fra listen over valgmuligheder.'),
      colorId: guidSchema.optional().describe('Id på farven fra listen over valgmuligheder.'),
      upholsteryId: guidSchema.optional().describe('Id på polstringen fra listen over valgmuligheder.'),
      upholsteryColorId: guidSchema.optional().describe('Id på polstringens farve fra listen over valgmuligheder.'),
      internalVehicleNumber: z.string().trim().min(1).max(255).optional().describe('Forhandlerens eget nummer på bilen.'),
      visibility: z
        .enum(['External', 'Internal'])
        .optional()
        .describe('External (standard): i Bilinfo og på Bilbasen og DBA. Internal: kun i Bilinfo, annoncen er taget af.'),
      vehicleStatus: z
        .enum(['InStock', 'Entering', 'Reserved', 'Sold', 'NotAssigned', 'Detailing', 'InTransport', 'PaintShop', 'PendingPictures', 'WorkShop'])
        .optional()
        .describe(
          'Bilens status hos forhandleren: InStock (på lager), Entering (på vej ind), Reserved (reserveret), Detailing ' +
            '(klargøring), InTransport (under transport), PaintShop (lakering), PendingPictures (mangler billeder), ' +
            'WorkShop (værksted), NotAssigned eller Sold. Udelades den, beholder en bil sin status.',
        ),
      wholesalePrice: moneySchema.optional().describe('Engrospris i kroner med leveringsomkostninger.'),
      purchasePrice: moneySchema.optional().describe('Indkøbspris i kroner.'),
      preparationCost: moneySchema.optional().describe('Klargøringsomkostninger i kroner.'),
      registrationFee: moneySchema.optional().describe('Registreringsafgift i kroner.'),
      taxationBasis: moneySchema.optional().describe('Beskatningsgrundlag i kroner (leasing).'),
      marketValue: z.number().int().min(0).max(100_000_000).optional().describe('Markedsværdi i kroner (leasing).'),
      mileageWarrantyIncluded: z.boolean().optional().describe('true, når forhandleren garanterer kilometertallet.'),
      isImportedCar: z.boolean().optional().describe('true, når bilen er importeret.'),
      numberOfKeys: z.number().int().min(0).max(20).optional().describe('Antal nøgler.'),
      serviceBook: z.enum(['NotFilledOut', 'FilledOut', 'PartiallyFilledOut']).optional().describe('Servicebog: FilledOut, PartiallyFilledOut eller NotFilledOut.'),
      damaged: z.enum(['Unknown', 'No', 'Yes']).optional().describe('Har bilen haft skader: Unknown, No eller Yes.'),
      severelyDamaged: z.enum(['Unknown', 'No', 'Yes']).optional().describe('Har bilen haft større skader: Unknown, No eller Yes.'),
      formerUse: z
        .enum(['Unknown', 'Privat', 'BusinessUse', 'Taxa', 'Rental', 'Leasing', 'New'])
        .optional()
        .describe('Tidligere brug: Unknown, Privat, BusinessUse, Taxa, Rental, Leasing eller New.'),
      particleFilter: z.boolean().optional().describe('true, når bilen har partikelfilter.'),
      euroNorm: z.enum(['NotSpecified', 'Euro1', 'Euro2', 'Euro3', 'Euro4', 'Euro5', 'Euro6']).optional().describe('Euronorm.'),
      co2Emission: z.number().min(0).max(10_000).optional().describe('CO2-udslip i g/km. Skal angives for en bil med forbrændingsmotor registreret efter 1. juli 2021.'),
      kmPerLiter: z.number().min(0).max(1_000).optional().describe('Kilometer pr. liter.'),
      wltpKmPerLiter: z.number().min(0).max(1_000).optional().describe('Kilometer pr. liter efter WLTP.'),
      electricConsumption: z.number().min(0).max(1_000).optional().describe('Elforbrug i kilometer pr. kWh.'),
      batterySize: z.number().min(0).max(1_000).optional().describe('Batteriets størrelse i kWh.'),
      range: z.number().min(0).max(5_000).optional().describe('Rækkevidde på el i kilometer.'),
      chargingPowerAc: z.number().min(0).max(1_000).optional().describe('Største ladeeffekt med vekselstrøm (AC) i kW.'),
      chargingPowerDc: z.number().int().min(0).max(2_000).optional().describe('Største ladeeffekt med jævnstrøm (DC) i kW.'),
      chargeTimeDc: z.number().int().min(0).max(1_000).optional().describe('Minutter til at lade fra 10 til 80 % med jævnstrøm.'),
      trailerWeight: z.number().int().min(0).max(100_000).optional().describe('Største vægt på anhænger i kg.'),
      timingBelt: z
        .strictObject({
          replaced: z.enum(['Unknown', 'Yes', 'No', 'NoTimingBelt']).describe('Er tandremmen skiftet: Unknown, Yes, No eller NoTimingBelt.'),
          date: dateSchema.optional().describe('Hvornår den blev skiftet, ÅÅÅÅ-MM-DD.'),
          mileage: z.number().int().min(0).max(3_000_000).optional().describe('Kilometer kørt med den nuværende tandrem.'),
        })
        .optional()
        .describe('Tandrem.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Bilen er sendt til Bilinfo.',
    upstream: [{ access: 'write', method: 'POST', service: 'cars', path: SAVE_CAR_PATH }],
    handler: async (client, input) => saveCar(client, input as SaveCarInput),
  }),
  defineTool({
    name: 'bilinfo_mark_car_sold',
    title: 'Marker en bil som solgt (Bilinfo)',
    description:
      'Markerer en bil, forbindelsen har oprettet, som solgt i Bilinfo. Bilinfo tager den af Bilbasen og DBA og ' +
      'beholder den med sin historik. Kan ikke fortrydes gennem forbindelsen, og en solgt bil kan ikke rettes bagefter. ' +
      'Ændringen sker med det samme i Bilinfo.',
    inputShape: {
      carId: carIdSchema.describe('Bilens id, som den blev oprettet med (carId).'),
      soldTo: z.enum(['private', 'business']).describe('private: solgt til en privatperson. business: solgt til et firma (engros).'),
      salesPrice: moneySchema.optional().describe('Salgsprisen i kroner, hvis den skal med.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Bilen er meldt solgt til Bilinfo.',
    upstream: [{ access: 'write', method: 'POST', service: 'cars', path: SELL_CAR_PATH }],
    handler: async (client, input) => sellCar(client, input),
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

  // A change for a person the host names is refused: the Car API and the Leads API have no users, so it could only be
  // made as the connection itself (src/act-as.ts: no fallback for a change). A read goes as the connection.
  if (!tool.annotations.readOnlyHint && currentActAs() !== undefined) {
    throw new ActAsRefusedError('not_permitted');
  }

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
