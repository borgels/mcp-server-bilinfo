import type { UpstreamClient } from './client.js';

/**
 * The Listing API has one request: the whole list of a Bilinfo account's
 * vehicles for sale. There is no request for one vehicle and no filter but
 * the dealer, so every tool reads the list and works on it.
 *
 * Nothing is kept between calls. Each call reads the list from Bilinfo,
 * builds its answer and lets the list go.
 *
 * Bilinfo sends every value as text ("55000", "06-10-2006"). The readers
 * below turn the ones we compute with into numbers and ISO dates; a value in
 * another form is left out, never guessed.
 */

/** The one request of the Listing API, relative to the base URL. */
export const EXPORT_PATH = '/api/export';

/** Texts a person may read, in Danish. */
export const UNEXPECTED_ANSWER = 'Bilinfo svarede i en form, der ikke kan læses som en liste af biler.';
export const VEHICLE_NOT_FOUND =
  'Bilen findes ikke blandt bilerne til salg i Bilinfo lige nu. Den kan være solgt eller taget af nettet. Brug vehicleId fra listen over biler.';

/** One vehicle as Bilinfo sends it. */
export type RawVehicle = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the account's vehicles for sale from Bilinfo, limited to the instance's dealer when it has one. */
export async function fetchVehicles(client: UpstreamClient): Promise<RawVehicle[]> {
  const body = await client.get<unknown>(EXPORT_PATH, client.dealerId ? { dealerId: client.dealerId } : undefined);
  // Anything but the documented list is refused with our own text: an unknown body is never passed on.
  if (!isRecord(body) || !Array.isArray(body.Vehicles) || !body.Vehicles.every(isRecord)) {
    throw new Error(UNEXPECTED_ANSWER);
  }
  return body.Vehicles as RawVehicle[];
}

function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function wholeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== 'string' || !/^-?\d{1,15}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** Bilinfo's dates: day-month-year, with a time of day on created and modified dates. */
const BILINFO_DATE = /^(\d{2})-(\d{2})-(\d{4})(?: \d{2}:\d{2}:\d{2})?$/;

/** The calendar date of a Bilinfo date as YYYY-MM-DD, or undefined when it is not a real date in that form. */
export function isoDate(value: unknown): string | undefined {
  const match = typeof value === 'string' ? BILINFO_DATE.exec(value.trim()) : null;
  if (!match) return undefined;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const iso = `${year}-${month}-${day}`;
  return date.toISOString().slice(0, 10) === iso ? iso : undefined;
}

/** Today's date in Denmark as YYYY-MM-DD: the age of a listing is counted in Danish calendar days. */
export function danishToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Whole days from one ISO date to another; a date after `to` counts as 0. */
function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

/** The price types whose price is what the vehicle costs to buy, as the documentation lists them. */
const PURCHASE_PRICE_TYPES: ReadonlySet<string> = new Set(['RetailPrice', 'RetailPriceWithoutTax']);

/** A compact row for one listing: what a dealer looks for first. Fields Bilinfo did not send are left out. */
export interface VehicleRow {
  /** The listing's id (VehicleId). One car can have several listings, e.g. one for sale and one for leasing. */
  vehicleId?: string;
  make?: string;
  model?: string;
  variant?: string;
  /** Model year (Year). */
  year?: number;
  mileageKm?: number;
  /** Propellant, e.g. Benzin, Diesel or El. */
  fuel?: string;
  /** SecondaryPropellant: the second one of a hybrid. */
  secondaryFuel?: string;
  /** GearType as Bilinfo sends it: A or M. */
  gearType?: string;
  /** Type, e.g. Personvogn or Varevogn +Moms. */
  type?: string;
  /** Price: the advertised price of the listing's price type. Left out for CallForPrice. */
  price?: number;
  /** PriceType: RetailPrice, RetailPriceWithoutTax, Leasing or CallForPrice. */
  priceType?: string;
  /** The day the listing was created in Bilinfo (CreatedDate), YYYY-MM-DD. */
  createdDate?: string;
  /** Days from createdDate to today. */
  daysSinceCreated?: number;
  pictureCount?: number;
  /** DealerName; only when the answer holds vehicles from more than one dealer. */
  dealer?: string;
}

export function toRow(vehicle: RawVehicle, today: string): VehicleRow {
  const createdDate = isoDate(vehicle.CreatedDate);
  const priceType = text(vehicle.PriceType);
  return {
    vehicleId: text(vehicle.VehicleId),
    make: text(vehicle.Make),
    model: text(vehicle.Model),
    variant: text(vehicle.Variant),
    year: wholeNumber(vehicle.Year),
    mileageKm: wholeNumber(vehicle.Mileage),
    fuel: text(vehicle.Propellant),
    secondaryFuel: text(vehicle.SecondaryPropellant),
    gearType: text(vehicle.GearType),
    type: text(vehicle.Type),
    price: priceType === 'CallForPrice' ? undefined : wholeNumber(vehicle.Price),
    priceType,
    createdDate,
    daysSinceCreated: createdDate === undefined ? undefined : daysBetween(createdDate, today),
    pictureCount: wholeNumber(vehicle.PictureCount),
  };
}

function lower(value: string): string {
  return value.toLocaleLowerCase('da-DK');
}

function dealerNames(vehicles: readonly RawVehicle[]): string[] {
  return [...new Set(vehicles.map(vehicle => text(vehicle.DealerName)).filter((name): name is string => name !== undefined))].sort((a, b) =>
    a.localeCompare(b, 'da-DK'),
  );
}

/** Rows for a set of vehicles; the dealer's name is added when there is more than one dealer among them all. */
function toRows(vehicles: readonly RawVehicle[], all: readonly RawVehicle[], today: string): VehicleRow[] {
  const severalDealers = dealerNames(all).length > 1;
  return vehicles.map(vehicle => (severalDealers ? { ...toRow(vehicle, today), dealer: text(vehicle.DealerName) } : toRow(vehicle, today)));
}

/** The texts a free-text search looks in. */
function searchText(vehicle: RawVehicle): string {
  const equipment = Array.isArray(vehicle.ExtraEquipmentList)
    ? vehicle.ExtraEquipmentList.map(entry => (isRecord(entry) ? text(entry.Name) : undefined))
    : [];
  return lower(
    [vehicle.Make, vehicle.Model, vehicle.Variant, vehicle.Type, vehicle.BodyType, vehicle.Color, vehicle.Propellant, vehicle.SecondaryPropellant, vehicle.Comment]
      .map(text)
      .concat(equipment)
      .filter((part): part is string => part !== undefined)
      .join(' \n '),
  );
}

export type VehicleSort = 'longest_listed' | 'newest_listed' | 'price_low' | 'price_high';

export interface ListVehiclesInput {
  make?: string;
  model?: string;
  fuel?: string;
  priceMin?: number;
  priceMax?: number;
  yearMin?: number;
  yearMax?: number;
  query?: string;
  sort?: VehicleSort;
  page?: number;
  pageSize?: number;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

function matches(vehicle: RawVehicle, input: ListVehiclesInput): boolean {
  if (input.make !== undefined && !lower(text(vehicle.Make) ?? '').includes(lower(input.make))) return false;
  if (input.model !== undefined && !lower(text(vehicle.Model) ?? '').includes(lower(input.model))) return false;
  if (input.fuel !== undefined) {
    const wanted = lower(input.fuel);
    if (![vehicle.Propellant, vehicle.SecondaryPropellant].some(fuel => lower(text(fuel) ?? '') === wanted)) return false;
  }
  if (input.priceMin !== undefined || input.priceMax !== undefined) {
    // A price range is about what the vehicle costs to buy: a leasing price is another kind of amount.
    const price = PURCHASE_PRICE_TYPES.has(text(vehicle.PriceType) ?? '') ? wholeNumber(vehicle.Price) : undefined;
    if (price === undefined) return false;
    if (input.priceMin !== undefined && price < input.priceMin) return false;
    if (input.priceMax !== undefined && price > input.priceMax) return false;
  }
  if (input.yearMin !== undefined || input.yearMax !== undefined) {
    const year = wholeNumber(vehicle.Year);
    if (year === undefined) return false;
    if (input.yearMin !== undefined && year < input.yearMin) return false;
    if (input.yearMax !== undefined && year > input.yearMax) return false;
  }
  if (input.query !== undefined) {
    const haystack = searchText(vehicle);
    if (!lower(input.query).split(/\s+/).filter(Boolean).every(word => haystack.includes(word))) return false;
  }
  return true;
}

/** Sorted copy; rows without the value sorted by come last, and equal rows keep Bilinfo's order. */
function sorted(rows: VehicleRow[], sort: VehicleSort | undefined): VehicleRow[] {
  if (sort === undefined) return rows;
  const byPrice = sort === 'price_low' || sort === 'price_high';
  const value = (row: VehicleRow): number | undefined =>
    byPrice ? (PURCHASE_PRICE_TYPES.has(row.priceType ?? '') ? row.price : undefined) : row.daysSinceCreated;
  const descending = sort === 'price_high' || sort === 'longest_listed';
  return rows
    .map((row, index) => ({ row, index, value: value(row) }))
    .sort((a, b) => {
      if (a.value === undefined || b.value === undefined) {
        return a.value === b.value ? a.index - b.index : a.value === undefined ? 1 : -1;
      }
      return (descending ? b.value - a.value : a.value - b.value) || a.index - b.index;
    })
    .map(entry => entry.row);
}

export interface VehicleList {
  /** Listings that match the filters. */
  matching: number;
  /** Listings in the answer from Bilinfo, before the filters. */
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  vehicles: VehicleRow[];
}

export function listVehicles(all: readonly RawVehicle[], input: ListVehiclesInput, today: string): VehicleList {
  const rows = sorted(toRows(all.filter(vehicle => matches(vehicle, input)), all, today), input.sort);
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const page = input.page ?? 1;
  return {
    matching: rows.length,
    total: all.length,
    page,
    pageSize,
    pageCount: Math.ceil(rows.length / pageSize),
    vehicles: rows.slice((page - 1) * pageSize, page * pageSize),
  };
}

/** Fields left out of a vehicle's details: the documentation calls them legacy and deprecated. */
const LEFT_OUT_FIELDS: ReadonlySet<string> = new Set(['Id', 'EquipmentList']);

export interface VehicleDetails {
  summary: VehicleRow;
  /** Every field Bilinfo sent for the listing, as it was sent, but for the two the documentation has retired. */
  fields: Record<string, unknown>;
  /** Other listings of the same car (the same VehicleSourceId), e.g. the leasing listing of a car also for sale. */
  otherListingsOfSameCar?: Array<Pick<VehicleRow, 'vehicleId' | 'priceType' | 'price'>>;
}

export function getVehicle(all: readonly RawVehicle[], vehicleId: string, today: string): VehicleDetails {
  const wanted = vehicleId.trim().toLowerCase();
  const vehicle = all.find(candidate => text(candidate.VehicleId)?.toLowerCase() === wanted);
  if (!vehicle) {
    throw new Error(VEHICLE_NOT_FOUND);
  }
  const sourceId = text(vehicle.VehicleSourceId)?.toLowerCase();
  const others =
    sourceId === undefined
      ? []
      : all.filter(candidate => candidate !== vehicle && text(candidate.VehicleSourceId)?.toLowerCase() === sourceId);
  const [summary] = toRows([vehicle], all, today);
  return {
    summary: summary!,
    fields: Object.fromEntries(Object.entries(vehicle).filter(([field]) => !LEFT_OUT_FIELDS.has(field))),
    ...(others.length > 0
      ? {
          otherListingsOfSameCar: others.map(other => {
            const { vehicleId: id, priceType, price } = toRow(other, today);
            return { vehicleId: id, priceType, price };
          }),
        }
      : {}),
  };
}

/** Upper bounds, in days since a listing was created, of the age groups; the last group has none. */
const AGE_GROUPS: ReadonlyArray<{ label: string; upTo: number }> = [
  { label: '0-30 dage', upTo: 30 },
  { label: '31-60 dage', upTo: 60 },
  { label: '61-90 dage', upTo: 90 },
  { label: '91-180 dage', upTo: 180 },
  { label: 'over 180 dage', upTo: Number.POSITIVE_INFINITY },
];

const UNKNOWN_MAKE = 'Ukendt mærke';

export interface StockOverview {
  /** Listings in the answer from Bilinfo. */
  listings: number;
  /** Different cars among them: a car with two listings (for sale and for leasing) counts once. */
  cars: number;
  /** Asking prices added up per price type, for the two types that are a price to buy the car. */
  askingPrices: Array<{ priceType: string; listings: number; total?: number; average?: number }>;
  byMake: Array<{ make: string; cars: number }>;
  /** Cars by the number of days since they were created in Bilinfo (CreatedDate). */
  byDaysSinceCreated: {
    groups: Array<{ group: string; cars: number }>;
    averageDays?: number;
    longest?: Pick<VehicleRow, 'vehicleId' | 'make' | 'model' | 'createdDate' | 'daysSinceCreated'>;
    /** Cars without a readable CreatedDate, left out of the groups. */
    withoutDate: number;
  };
  /** Only when the answer holds vehicles from more than one dealer. */
  dealers?: Array<{ dealer: string; cars: number }>;
}

export function stockOverview(all: readonly RawVehicle[], today: string): StockOverview {
  // One entry per car: a car's listings share VehicleSourceId. Its age is counted from its earliest listing.
  const cars = new Map<string, { vehicle: RawVehicle; row: VehicleRow }>();
  all.forEach((vehicle, index) => {
    const key = text(vehicle.VehicleSourceId)?.toLowerCase() ?? text(vehicle.VehicleId)?.toLowerCase() ?? `#${index}`;
    const row = toRow(vehicle, today);
    const known = cars.get(key);
    if (!known || (row.daysSinceCreated ?? -1) > (known.row.daysSinceCreated ?? -1)) {
      cars.set(key, { vehicle, row });
    }
  });

  const prices = new Map<string, { listings: number; total: number; priced: number }>();
  for (const vehicle of all) {
    const priceType = text(vehicle.PriceType) ?? 'Ukendt';
    const entry = prices.get(priceType) ?? { listings: 0, total: 0, priced: 0 };
    entry.listings += 1;
    const price = PURCHASE_PRICE_TYPES.has(priceType) ? wholeNumber(vehicle.Price) : undefined;
    if (price !== undefined) {
      entry.total += price;
      entry.priced += 1;
    }
    prices.set(priceType, entry);
  }

  const count = (names: Array<string | undefined>, unknown: string) => {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name ?? unknown, (counts.get(name ?? unknown) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'da-DK'));
  };

  const dated = [...cars.values()].map(car => car.row).filter(row => row.daysSinceCreated !== undefined);
  const longest = dated.reduce<VehicleRow | undefined>(
    (best, row) => (best === undefined || row.daysSinceCreated! > best.daysSinceCreated! ? row : best),
    undefined,
  );
  const dealers = count([...cars.values()].map(car => text(car.vehicle.DealerName)), 'Ukendt forhandler');

  return {
    listings: all.length,
    cars: cars.size,
    askingPrices: [...prices].map(([priceType, entry]) => ({
      priceType,
      listings: entry.listings,
      ...(entry.priced > 0 ? { total: entry.total, average: Math.round(entry.total / entry.priced) } : {}),
    })),
    byMake: count([...cars.values()].map(car => car.row.make), UNKNOWN_MAKE).map(([make, n]) => ({ make, cars: n })),
    byDaysSinceCreated: {
      groups: AGE_GROUPS.map((group, index) => ({
        group: group.label,
        cars: dated.filter(row => row.daysSinceCreated! <= group.upTo && row.daysSinceCreated! > (AGE_GROUPS[index - 1]?.upTo ?? -1)).length,
      })),
      ...(dated.length > 0
        ? { averageDays: Math.round(dated.reduce((sum, row) => sum + row.daysSinceCreated!, 0) / dated.length) }
        : {}),
      ...(longest
        ? {
            longest: {
              vehicleId: longest.vehicleId,
              make: longest.make,
              model: longest.model,
              createdDate: longest.createdDate,
              daysSinceCreated: longest.daysSinceCreated,
            },
          }
        : {}),
      withoutDate: cars.size - dated.length,
    },
    ...(dealers.length > 1 ? { dealers: dealers.map(([dealer, n]) => ({ dealer, cars: n })) } : {}),
  };
}
