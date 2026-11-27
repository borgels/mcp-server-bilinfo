import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { z } from 'zod/v4';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BilinfoClient, type BilinfoClientOptions } from '../src/bilinfo/client.js';
import { createBilinfoGateway, type BilinfoGatewayOptions } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { WRITE_TOOL_ANNOTATIONS } from '../src/bilinfo/annotations.js';
import { BILINFO_TOOLS, type ToolDefinition } from '../src/tools/bilinfo.js';

/** A host that does not exist: every test answers with a stub, and nothing reaches Bilinfo. */
export const BASE = 'https://listing.bilinfo.test/listingapi';
/** The one request the tools make. */
export const EXPORT_URL = `${BASE}/api/export`;

/** Invented credentials. */
export const USERNAME = 'fjordby-test';
export const PASSWORD = 'tttt-gggg-wwww-vvvv-1';

export type Stub = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> };

/** A fetch stub keyed by "METHOD URL" (URL without query string). Unknown routes answer 404. */
export function stubFetch(routes: Record<string, Stub>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).split('?')[0] ?? '';
    const stub = routes[`${init?.method ?? 'GET'} ${url}`];
    if (!stub) {
      return new Response(JSON.stringify({ message: `no stub for ${url}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (stub.raw !== undefined) {
      return new Response(stub.raw, { status: stub.status ?? 200, headers: { 'content-type': 'text/plain', ...stub.headers } });
    }
    return new Response(JSON.stringify(stub.body), {
      status: stub.status ?? 200,
      headers: { 'content-type': 'application/json', ...stub.headers },
    });
  });
}

export function makeClient(fetchImpl: unknown, extra: Partial<BilinfoClientOptions> = {}) {
  return new BilinfoClient({
    username: USERNAME,
    password: 'kode-til-test-4711',
    baseUrl: BASE,
    allowCustomBaseUrl: true,
    fetchImpl: fetchImpl as typeof fetch,
    ...extra,
  });
}

export async function connect(routes: Record<string, Stub> = {}) {
  const fetchImpl = stubFetch(routes);
  const server = createServer({ client: makeClient(fetchImpl) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return { mcpClient, fetchImpl };
}

/** The other services, on hosts that do not exist either. */
export const SERVICES = {
  token: 'https://accounts.bilinfo.test/oauth/connect/token',
  dealerLookup: 'https://dealerlookup.bilinfo.test/api',
  userLookup: 'https://userlookup.bilinfo.test/api',
  casePlugin: 'https://gw.bilinfo.test',
} as const;
/** An invented client, plugin identifier and access token. */
export const CLIENT_ID = 'fjordby-klient';
export const CLIENT_SECRET = 'hhhh-jjjj-qqqq-xxxx-2';
export const PLUGIN_ID = 'eksempelfinans';
export const ACCESS_TOKEN = 'zzzz.yyyy.token-0001';
/** The authorization service issuing a token. */
export const TOKEN_ROUTE: Record<string, Stub> = {
  [`POST ${SERVICES.token}`]: { body: { access_token: ACCESS_TOKEN, expires_in: 360, token_type: 'Bearer' } },
};

/** Gateway options with both pairs of invented credentials, a dealer, a plugin identifier and the test hosts. */
export function fullOptions(extra: Partial<BilinfoGatewayOptions> = {}): BilinfoGatewayOptions {
  return gatewayOptions({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    pluginId: PLUGIN_ID,
    dealerId: FJORDBY.DealerGuid,
    serviceUrls: SERVICES,
    ...extra,
  });
}

/** Gateway options with the invented credentials and the test host. */
export function gatewayOptions(extra: Partial<BilinfoGatewayOptions> = {}): BilinfoGatewayOptions {
  return { username: USERNAME, password: PASSWORD, baseUrl: BASE, allowCustomBaseUrl: true, ...extra };
}

export function gateway(routes: Record<string, Stub> = {}, extra: Partial<BilinfoGatewayOptions> = {}) {
  const fetchImpl = stubFetch(routes);
  const gw = createBilinfoGateway(gatewayOptions({ fetchImpl: fetchImpl as unknown as typeof fetch, ...extra }));
  return { gw, fetchImpl };
}

export function texts(result: unknown): string[] {
  return (((result as { content?: unknown }).content ?? []) as Array<{ text: string }>).map(c => c.text);
}

export function auditLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Invented dealers and vehicles in the form the Listing API answers in: every
 * value is text, dates are day-month-year, and each vehicle carries its
 * dealer. None of it is a real dealer, car or answer.
 */
export const FJORDBY = {
  DealerName: 'Fjordby Biler A/S',
  DealerId: '90001',
  DealerGuid: '0f0f0f0f-aaaa-4bbb-8ccc-000000000001',
  DealerAddressStreetLine1: 'Eksempelvej 1',
  DealerAddressStreetLine2: '',
  DealerAddressZipCode: '9999',
  DealerAddressCity: 'Fjordby',
  DealerPhoneNumber: '00000001',
  DealerAlternativePhoneNumber: '',
  DealerEmail: 'salg@fjordbybiler.example',
  DealerWebsite: 'https://fjordbybiler.example',
  DealerDeliveryCost: '3980',
  DealerDeliveryCostNewCars: '3980',
  DealerDeliveryCostVans: '3980',
  DealerDeliveryCostNewVans: '3980',
  DealerLicensePlatePrice: '1180',
} as const;

export const NORDKYST = {
  ...FJORDBY,
  DealerName: 'Nordkyst Automobiler ApS',
  DealerId: '90002',
  DealerGuid: '0f0f0f0f-aaaa-4bbb-8ccc-000000000002',
  DealerAddressStreetLine1: 'Prøvegade 2',
  DealerAddressCity: 'Nordkyst',
  DealerPhoneNumber: '00000002',
  DealerEmail: 'salg@nordkystauto.example',
  DealerWebsite: 'https://nordkystauto.example',
} as const;

function guid(group: string, n: number): string {
  return `${group}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** The id of the n-th invented listing and car. */
export const listingId = (n: number) => guid('aaaaaaaa', n);
export const carId = (n: number) => guid('bbbbbbbb', n);

/** One vehicle in Bilinfo's form. `n` gives it its ids; `fields` replaces or adds fields. */
export function vehicle(n: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: String(5_000_000 + n),
    Mileage: '55000',
    Year: '2019',
    Make: 'Volkswagen',
    Model: 'Golf',
    Variant: '1,5 TSi 150 Style DSG',
    RegistrationDate: '14-03-2019',
    ServiceBook: 'true',
    Type: 'Personvogn',
    TypeId: '1',
    Motor: '1,5',
    Propellant: 'Benzin',
    GearType: 'A',
    Effect: '150',
    BodyType: 'Hatchback',
    BodyTypes: ['Hatchback'],
    Color: 'Grå',
    NumberOfDoors: '5',
    Comment: 'Velholdt bil med fuld servicehistorik.',
    EquipmentList: ['Fartpilot', 'Klimaanlæg'],
    ExtraEquipmentList: [
      { Id: '11', Name: 'Fartpilot' },
      { Id: '12', Name: 'Klimaanlæg' },
    ],
    PictureCount: '2',
    Pictures: [
      `https://billeder.bilinfo.test/bilinfo/${guid('cccccccc', n)}.jpg?class=S1600X1600`,
      `https://billeder.bilinfo.test/bilinfo/${guid('dddddddd', n)}.jpg?class=S1600X1600`,
    ],
    ModifiedDate: '02-11-2026 09:15:00',
    CreatedDate: '01-10-2026 12:30:00',
    SpecificationId: '700001',
    VehicleId: listingId(n),
    VehicleSourceId: carId(n),
    Price: '189900',
    PriceType: 'RetailPrice',
    CashPrice: '189900',
    ApprovedFuelEconomyMeasurementMethod: 'WLTP',
    Version: 3,
    SaleType: 'RetailSale',
    ...FJORDBY,
    ...fields,
  };
}

/** The body of an answer from the Listing API with these vehicles. */
export function exportBody(vehicles: Array<Record<string, unknown>>) {
  return { ApiVersion: '3', VehicleCount: vehicles.length, NextVersionNumber: 4, Vehicles: vehicles };
}

/** Routes for a stub that answers the export request with these vehicles. */
export function exportRoutes(vehicles: Array<Record<string, unknown>>): Record<string, Stub> {
  return { [`GET ${EXPORT_URL}`]: { body: exportBody(vehicles) } };
}

/** The day the tests take as today: only the clock's date is faked, so timers and requests run as usual. */
export const TODAY = '2026-11-25';
export function freezeToday(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T10:00:00Z`));
}

/** A small stock: five listings of four cars at one dealer. */
export function sampleStock(): Array<Record<string, unknown>> {
  return [
    vehicle(1),
    vehicle(2, {
      Make: 'Skoda',
      Model: 'Enyaq',
      Variant: '80 iV Loft',
      Year: '2022',
      Mileage: '31000',
      Propellant: 'El',
      Color: 'Blå',
      Price: '299900',
      CashPrice: '299900',
      CreatedDate: '10-11-2026 08:00:00',
      Comment: 'Én ejer. Varmepumpe og anhængertræk.',
      ExtraEquipmentList: [{ Id: '21', Name: 'Anhængertræk' }],
    }),
    // The same car as listing 2, also offered for leasing: the price is per month.
    vehicle(3, {
      VehicleSourceId: carId(2),
      Make: 'Skoda',
      Model: 'Enyaq',
      Variant: '80 iV Loft',
      Year: '2022',
      Mileage: '31000',
      Propellant: 'El',
      Price: '3495',
      PriceType: 'Leasing',
      CashPrice: undefined,
      LeasingPrice: '3495',
      LeasingType: 'Privat',
      LeasingDuration: '36',
      CreatedDate: '12-11-2026 08:00:00',
    }),
    vehicle(4, {
      Make: 'Ford',
      Model: 'Transit Custom',
      Variant: '2,0 TDCi 130 Trend',
      Type: 'Varevogn +Moms',
      Year: '2020',
      Mileage: '98000',
      Propellant: 'Diesel',
      GearType: 'M',
      Price: '164900',
      PriceType: 'RetailPriceWithoutTax',
      CashPrice: undefined,
      CreatedDate: '15-04-2026 10:00:00',
      Comment: '',
    }),
    vehicle(5, {
      Make: 'Volkswagen',
      Model: 'Passat',
      Variant: '1,4 GTE Variant DSG',
      Year: '2021',
      Mileage: '72000',
      Propellant: 'Benzin',
      SecondaryPropellant: 'El',
      Price: '0',
      PriceType: 'CallForPrice',
      CashPrice: undefined,
      CreatedDate: '20-08-2026 14:00:00',
    }),
  ].map(entry => Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)));
}

/**
 * This version has no tool that changes anything in Bilinfo. The write gate
 * (policy, start record, per-instance isolation) is part of every server all
 * the same, so the tests that prove it add a write tool that exists only in
 * the tests, `test_write`, and take it away again. Its handler sends nothing:
 * it records that it ran.
 */
export function installTestWriteTool(): { runs: Array<Record<string, unknown>>; remove: () => void } {
  const runs: Array<Record<string, unknown>> = [];
  const inputShape = { vehicleId: z.string().optional(), query: z.string().optional() };
  const tool = {
    name: 'bilinfo_test_write',
    title: 'Test write',
    description: 'A write tool that exists only in the tests.',
    inputShape,
    inputSchema: z.strictObject(inputShape),
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Done.',
    upstream: [],
    handler: async (_client: unknown, input: Record<string, unknown>) => {
      runs.push(input);
      return { ok: true };
    },
  } as unknown as ToolDefinition;
  BILINFO_TOOLS.push(tool);
  return {
    runs,
    remove: () => {
      const index = BILINFO_TOOLS.indexOf(tool);
      if (index >= 0) BILINFO_TOOLS.splice(index, 1);
    },
  };
}
