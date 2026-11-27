/**
 * Bilinfo Car API (developer.bilinfo.net, API "CarApi", path carapiqa in QA):
 * the dealer's own cars in Bilinfo, which Bilinfo advertises on Bilbasen and
 * DBA. Three things a dealer does every day:
 *
 * - create a car, or change one: one POST with the whole car. Bilinfo sets
 *   the car to exactly what the last request holds, so a change sends every
 *   field again, with a higher version number;
 * - take a car's ad off Bilbasen and DBA without deleting anything: the same
 *   POST with visibility `Internal` (the car stays in Bilinfo);
 * - mark a car as sold: Bilinfo removes it from Bilbasen and keeps its
 *   history.
 *
 * The Car API has no request that reads a car back. Reading is the Listing
 * API's (vehicles.ts). The lists of colours, upholstery and extra equipment
 * whose ids a car must use are read here.
 *
 * Bilinfo answers a change with an operation status: a number from a fixed
 * list, and a message in Bilinfo's words. Only the number is used: it is
 * turned into our own Danish sentence (OPERATION_TEXTS). The message is
 * never passed on.
 */
import { encodePathParam } from '../path-params.js';
import type { ApiTarget, UpstreamClient } from './client.js';

/** The Car API's scopes (developer portal, each operation's "Authorization scope"). */
export const CARS_READ: ApiTarget = { service: 'cars', scope: 'https://carapi.ecgh.dk/auth/read' };
export const CARS_WRITE: ApiTarget = { service: 'cars', scope: 'https://carapi.ecgh.dk/auth/write' };

/** Path templates, relative to the Car API's base URL. */
export const SAVE_CAR_PATH = '/api/dealers/{dealerId}/cars';
export const SELL_CAR_PATH = '/api/dealers/{dealerId}/cars/sell';
export const CAR_OPTION_PATHS = {
  colors: '/api/cardetail/colors',
  upholstery: '/api/cardetail/upholstery',
  upholsteryColors: '/api/cardetail/upholstery/colors',
  extraEquipment: '/api/cardetail/extraequipments',
} as const;
export type CarOptionKind = keyof typeof CAR_OPTION_PATHS;
export const CAR_OPTION_KINDS = Object.keys(CAR_OPTION_PATHS) as CarOptionKind[];

/** In Danish: the person who asked reads them. */
export const NO_DEALER =
  'Denne forbindelse er ikke sat op til en bestemt forhandler, så der kan ikke oprettes, rettes eller sælges biler (BILINFO_DEALER_ID).';
export const OPTIONS_UNREADABLE = 'Bilinfo svarede i en form, der ikke kan læses som en liste af valgmuligheder.';
export const OPERATION_UNREADABLE =
  'Bilinfo svarede i en form, der ikke kan læses. Det er uvist, om ændringen er modtaget; se bilen i Bilinfo, før den sendes igen.';

/**
 * Bilinfo's operation statuses (the Car API's OperationStatusResponseDto), in our own words. 10, 20 and 30 mean the
 * request was taken; every other number means it was not, and nothing was changed.
 */
export const OPERATION_TEXTS: Readonly<Record<number, string>> = Object.freeze({
  10: 'Bilinfo har modtaget ændringen. Der kan gå lidt tid, før den ses i Bilinfo og på Bilbasen.',
  20: 'Bilinfo er ved at behandle ændringen. Der kan gå lidt tid, før den ses i Bilinfo og på Bilbasen.',
  30: 'Ændringen er gennemført i Bilinfo.',
  40: 'Bilinfo kunne ikke gennemføre ændringen. Se bilen i Bilinfo.',
  41: 'Bilinfo har allerede en nyere udgave af bilen. Send ændringen igen med et højere versionsnummer.',
  50: 'Bilinfo kender ikke forbindelsens integration.',
  51: 'Bilinfo kan ikke finde forbindelsens integration.',
  52: 'Bilen er oprettet af et andet system end denne forbindelse og kan ikke ændres herfra.',
  53: 'Forbindelsen må ikke ændre biler i Bilinfo.',
  60: 'Forhandlerens id er ikke gyldigt i Bilinfo.',
  61: 'Bilinfo kan ikke finde forhandleren.',
  62: 'Forhandleren har ikke det abonnement i Bilinfo, der skal til (Pro eller bedre).',
  63: 'Forhandleren hører ikke til forbindelsens koncern i Bilinfo.',
  64: 'Bilen tilhører en anden forhandler.',
  70: 'Bilens id er ikke gyldigt i Bilinfo.',
  71: 'Bilinfo kan ikke finde bilen.',
  72: 'Bilen er slettet i Bilinfo.',
  73: 'Bilen er oprettet direkte i Bilinfo og kan derfor ikke ændres gennem forbindelsen. Ret den i Bilinfo.',
  74: 'Bilen kan kun ændres fra det system, der oprettede den.',
  75: 'Bilen er slettet i Bilinfo og er sandsynligvis solgt.',
  76: 'Bilen opfylder ikke kravene til en fabriksny bil: under 2.000 km og højst fire år fra første registrering.',
  77: 'CO2-udslippet mangler. Det skal angives for en bil med forbrændingsmotor, der er registreret efter 1. juli 2021.',
  78: 'Kontantprisen er lavere, end Bilinfo tillader. Den skal være mindst 15.000 kr. for en bil, der er yngre end syv år.',
  79: 'Modellen kan ikke skiftes, fordi bilen har været annonceret i mere end 20 dage.',
  80: 'Varianten findes ikke i Bilinfos modelkatalog. Slå modellen op igen.',
});

const ACCEPTED: ReadonlySet<number> = new Set([10, 20, 30]);

/** What a refused change says when Bilinfo's status is not one of those in OPERATION_TEXTS. */
export const OPERATION_REFUSED = 'Bilinfo kunne ikke gennemføre ændringen. Intet blev ændret. Se bilen i Bilinfo.';

/**
 * Thrown when Bilinfo answered a change with a status that means it was not made: our sentence, and the number only
 * when it is one of those in our own table. An unknown number is not passed on.
 */
export class CarOperationError extends Error {
  readonly code?: number;
  constructor(status: number) {
    const known = Object.prototype.hasOwnProperty.call(OPERATION_TEXTS, status) && !ACCEPTED.has(status);
    super(known ? `${OPERATION_TEXTS[status]} (Bilinfos kode ${status})` : OPERATION_REFUSED);
    this.name = 'CarOperationError';
    if (known) this.code = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The outcome of a change as our own answer: the operation's id and status, and our sentence. Bilinfo's message is
 * left out. A status that means the change was not made is thrown as CarOperationError.
 */
export function operationOutcome(answer: unknown): { operationId?: string; status: number; text: string } {
  const status = isRecord(answer) ? answer.status : undefined;
  if (typeof status !== 'number' || !Number.isInteger(status)) {
    throw new Error(OPERATION_UNREADABLE);
  }
  if (!ACCEPTED.has(status)) {
    throw new CarOperationError(status);
  }
  const operationId = isRecord(answer) && typeof answer.operationId === 'string' ? answer.operationId : undefined;
  return { ...(operationId ? { operationId } : {}), status, text: OPERATION_TEXTS[status] as string };
}

function dealerOf(client: UpstreamClient): string {
  if (!client.dealerId) throw new Error(NO_DEALER);
  return client.dealerId;
}

/** One of the lists whose ids a car uses (colours, upholstery, upholstery colours, extra equipment): id and name. */
export async function listCarOptions(client: UpstreamClient, kind: CarOptionKind) {
  const answer = await client.get<unknown>(CAR_OPTION_PATHS[kind], undefined, CARS_READ);
  if (!Array.isArray(answer) || !answer.every(isRecord)) {
    throw new Error(OPTIONS_UNREADABLE);
  }
  const options = answer.map(entry => ({
    id: typeof entry.id === 'string' ? entry.id : undefined,
    name: typeof entry.name === 'string' ? entry.name : undefined,
  }));
  return { kind, count: options.length, options };
}

/** Price of a car, as the tool takes it. One of each kind at most, as the Car API allows. */
export interface CarPrices {
  cashPrice?: number;
  priceWithoutTax?: number;
  leasing?: {
    monthlyPayment: number;
    audience?: 'NotSpecified' | 'Private' | 'Business';
    type?: 'Operational' | 'Financial';
    durationMonths?: number;
    downPayment?: number;
    residualValue?: number;
    totalPayment?: number;
    yearlyMileage?: number;
    includesInsurance?: boolean;
    serviceAndMaintenance?: 'NotIncluded' | 'IncludedWithTires' | 'IncludedWithoutTires';
  };
}

/** The Car API's price list (Price with type and details). */
export function pricesOf(input: CarPrices): Array<{ type: string; details: Record<string, unknown> }> {
  const prices: Array<{ type: string; details: Record<string, unknown> }> = [];
  if (input.cashPrice !== undefined) prices.push({ type: 'CashPrice', details: { price: input.cashPrice } });
  if (input.priceWithoutTax !== undefined) prices.push({ type: 'WithoutTaxPrice', details: { price: input.priceWithoutTax } });
  if (input.leasing) {
    const { monthlyPayment, durationMonths, yearlyMileage, ...rest } = input.leasing;
    prices.push({
      type: 'LeasingPrice',
      details: dropUndefined({
        leasePayment: monthlyPayment,
        duration: durationMonths,
        yearlyMileage,
        ...rest,
      }),
    });
  }
  return prices;
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/** A date as the tool takes it (YYYY-MM-DD) in the Car API's date-time form, at midnight. */
function dateTime(date: string | undefined): string | undefined {
  return date === undefined ? undefined : `${date}T00:00:00`;
}

/** Bilinfo's version is a signed 32-bit number. */
export const MAX_VERSION = 2_147_483_647;

/** In Danish: the person who asked reads it. */
export const NO_VERSION_LEFT =
  'Bilinfo tager ikke et højere versionsnummer end 2147483647. Intet blev sendt; angiv selv et versionsnummer, der er højere end bilens sidste.';

/** The last version each client (one instance, one connection) made itself; never shared between instances. */
const lastMade = new WeakMap<object, number>();

/**
 * The version of a car upload when the caller gives none: whole seconds since 1970, and above the last one this
 * instance made itself (two saves within one second). A version a caller gives is used as it is and changes nothing
 * here. It fits Bilinfo's 32-bit number until 2038. Two instances saving the same car within one second can send the
 * same number; Bilinfo then refuses the second (status 41), and nothing is changed.
 */
export function nextVersion(owner: object, now: number = Date.now()): number {
  const version = Math.max(Math.floor(now / 1000), (lastMade.get(owner) ?? 0) + 1);
  if (version > MAX_VERSION) {
    throw new Error(NO_VERSION_LEFT);
  }
  lastMade.set(owner, version);
  return version;
}

/** The car as the save tool takes it: the Car API's CarDto, with dates as YYYY-MM-DD and prices as one object. */
export interface SaveCarInput extends CarPrices {
  carId: string;
  variantId: string;
  version?: number;
  mileage: number;
  isFactoryNew?: boolean;
  registrationDate?: string;
  registrationNumber?: string;
  vinNumber?: string;
  inspectionDate?: string;
  productionDate?: string;
  description?: string;
  pictures?: string[];
  extraEquipment?: string[];
  colorId?: string;
  upholsteryId?: string;
  upholsteryColorId?: string;
  internalVehicleNumber?: string;
  visibility?: 'External' | 'Internal';
  vehicleStatus?: string;
  vatOption?: 'VatFree' | 'NotVatFree';
  saleType?: 'RetailSale' | 'Consignment' | 'Facilitated';
  wholesalePrice?: number;
  purchasePrice?: number;
  preparationCost?: number;
  registrationFee?: number;
  taxationBasis?: number;
  marketValue?: number;
  mileageWarrantyIncluded?: boolean;
  isImportedCar?: boolean;
  numberOfKeys?: number;
  serviceBook?: 'NotFilledOut' | 'FilledOut' | 'PartiallyFilledOut';
  damaged?: 'Unknown' | 'No' | 'Yes';
  severelyDamaged?: 'Unknown' | 'No' | 'Yes';
  formerUse?: string;
  particleFilter?: boolean;
  euroNorm?: string;
  co2Emission?: number;
  kmPerLiter?: number;
  wltpKmPerLiter?: number;
  electricConsumption?: number;
  batterySize?: number;
  range?: number;
  chargingPowerAc?: number;
  chargingPowerDc?: number;
  chargeTimeDc?: number;
  trailerWeight?: number;
  timingBelt?: { replaced: 'Unknown' | 'Yes' | 'No' | 'NoTimingBelt'; date?: string; mileage?: number };
}

/** The request body of the Car API's upload, built only from what the tool took (never passed through as given). */
export function carBody(input: SaveCarInput, version: number): Record<string, unknown> {
  const { cashPrice, priceWithoutTax, leasing, registrationDate, inspectionDate, productionDate, timingBelt, version: _v, ...rest } = input;
  return dropUndefined({
    ...rest,
    version,
    isFactoryNew: input.isFactoryNew ?? false,
    registrationDate: dateTime(registrationDate),
    inspectionDate: dateTime(inspectionDate),
    productionDate: dateTime(productionDate),
    timingBelt: timingBelt ? dropUndefined({ ...timingBelt, date: dateTime(timingBelt.date) }) : undefined,
    prices: pricesOf({ cashPrice, priceWithoutTax, leasing }),
  });
}

/** Create a car for the instance's dealer, or change one (the whole car, with a higher version). Sent once. */
export async function saveCar(client: UpstreamClient, input: SaveCarInput, now: number = Date.now()) {
  const dealerId = dealerOf(client);
  const version = input.version ?? nextVersion(client, now);
  const answer = await client.post<unknown>(
    `/api/dealers/${encodePathParam(dealerId, 'dealerId')}/cars`,
    carBody(input, version),
    CARS_WRITE,
  );
  return { carId: input.carId, version, visibility: input.visibility ?? 'External', ...operationOutcome(answer) };
}

/** Mark a car of the instance's dealer as sold: Bilinfo removes it from Bilbasen and keeps it. Sent once. */
export async function sellCar(
  client: UpstreamClient,
  input: { carId: string; soldTo: 'private' | 'business'; salesPrice?: number },
) {
  const dealerId = dealerOf(client);
  const body = dropUndefined({
    carId: input.carId,
    salesPriceType: input.soldTo === 'business' ? 'Wholesale' : 'Retail',
    salesPrice: input.salesPrice,
  });
  const answer = await client.post<unknown>(`/api/dealers/${encodePathParam(dealerId, 'dealerId')}/cars/sell`, body, CARS_WRITE);
  return { carId: input.carId, ...operationOutcome(answer) };
}
