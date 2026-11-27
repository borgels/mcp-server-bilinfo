// The services other than the Listing API: the access token from Bilinfo's authorization service, the Car API
// (create, change and sell a car, and the lists its ids come from), the Leads API (read leads, set their status) and
// the Model Catalog. Everything is answered by a stand-in: no request leaves the test, and every value is invented.
import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { CARS_READ, CARS_WRITE, OPERATION_TEXTS } from '../src/bilinfo/cars.js';
import { BilinfoClient, SERVICE_URLS, SUBSCRIPTION_KEY_HEADER, UPSTREAM_HOST_SUFFIXES } from '../src/bilinfo/client.js';
import { LEADS_READ, LEADS_WRITE } from '../src/bilinfo/leads.js';
import { MODELS_DRILL_DOWN } from '../src/bilinfo/models.js';
import { createBilinfoGateway } from '../src/gateway.js';
import {
  ACCESS_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  FJORDBY,
  NORDKYST,
  SERVICES,
  SUBSCRIPTION_KEY,
  TOKEN_ROUTE,
  fullOptions,
  stubFetch,
  texts,
  type Stub,
} from './helpers.js';

type Call = [string, RequestInit];
const callsOf = (fetchImpl: { mock: { calls: unknown[] } }) => fetchImpl.mock.calls as unknown as Call[];
const headerOf = (call: Call | undefined, name: string) => (call?.[1].headers as Record<string, string> | undefined)?.[name];
const notToken = (fetchImpl: { mock: { calls: unknown[] } }) => callsOf(fetchImpl).filter(([url]) => url !== SERVICES.token);

const DEALER = FJORDBY.DealerGuid;
const SAVE_URL = `${SERVICES.cars}/api/dealers/${DEALER}/cars`;
const SELL_URL = `${SERVICES.cars}/api/dealers/${DEALER}/cars/sell`;
const COLORS_URL = `${SERVICES.cars}/api/cardetail/colors`;
const LEADS_URL = `${SERVICES.leads}/api/leads`;
const LEAD_ID = '11111111-2222-4333-8444-555555555555';
const LEAD_URL = `${SERVICES.leads}/api/leads/${LEAD_ID}`;
const BY_NUMBER_URL = `${SERVICES.models}/api/drill-down-by-reg-vin-number`;
const DRILL_DOWN_URL = `${SERVICES.models}/api/drill-down`;

const VARIANT = '0a0a0a0a-1111-4222-8333-444444444444';
const COLOR = '0b0b0b0b-1111-4222-8333-444444444444';
const PICTURE = 'https://billeder.bilinfo.net/bilinfo/0c0c0c0c-1111-4222-8333-444444444444.jpg';

/** An answer to a change in the Car API's form, with a message in Bilinfo's words that must never be passed on. */
const operation = (status: number) => ({ operationId: '0d0d0d0d-1111-4222-8333-444444444444', status, statusMessage: 'tekst fra Bilinfo 4711' });

/** A lead in the Leads API's form: an invented customer at an invented dealer. */
function lead(n: number, dealerId: string = DEALER) {
  return {
    id: `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`,
    dealerId,
    listingId: null,
    source: 'bilbasen',
    customer: { firstName: 'Test', lastName: `Kunde ${n}`, phone: '00000009', email: `kunde${n}@kunde.example` },
    car: { make: 'Skoda', model: 'Octavia', modelYear: 2021 },
    leadData: [{ key: 'Message', value: 'Er bilen stadig til salg?' }],
    version: 100 + n,
    createdDate: '2026-11-20T10:00:00Z',
  };
}

const CAR = { carId: 'LAGER-1001', variantId: VARIANT, mileage: 42000, registrationDate: '2021-03-14', cashPrice: 189900 };

function gatewayWith(routes: Record<string, Stub>, extra: Parameters<typeof fullOptions>[0] = {}) {
  const fetchImpl = stubFetch({ ...TOKEN_ROUTE, ...routes });
  const gw = createBilinfoGateway(fullOptions({ fetchImpl: fetchImpl as unknown as typeof fetch, maxAttempts: 1, ...extra }));
  return { gw, fetchImpl };
}

describe('the access token', () => {
  it('is asked for with the client id and secret as HTTP Basic and the scope of the service, then sent as Bearer', async () => {
    const { gw, fetchImpl } = gatewayWith({ [`GET ${COLORS_URL}`]: { body: [{ id: COLOR, name: 'Sort' }] } });
    const result = await gw.callTool('list_car_options', { kind: 'colors' });
    expect(result.isError, texts(result).join(' ')).toBeUndefined();

    const [token, read] = callsOf(fetchImpl);
    expect(token?.[0]).toBe(SERVICES.token);
    expect(token?.[1].method).toBe('POST');
    expect(headerOf(token, 'Authorization')).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, 'utf8').toString('base64')}`);
    expect(headerOf(token, 'Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(String(token?.[1].body))).toEqual(
      new URLSearchParams({ grant_type: 'client_credentials', scope: CARS_READ.scope! }),
    );
    // The gateway's subscription key goes to the service, never to the token service.
    expect(headerOf(token, SUBSCRIPTION_KEY_HEADER)).toBeUndefined();
    expect(read?.[0]).toBe(COLORS_URL);
    expect(headerOf(read, 'Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headerOf(read, SUBSCRIPTION_KEY_HEADER)).toBe(SUBSCRIPTION_KEY);
    for (const [url] of callsOf(fetchImpl)) {
      expect(url).not.toContain(CLIENT_SECRET);
      expect(url).not.toContain(ACCESS_TOKEN);
      expect(url).not.toContain(SUBSCRIPTION_KEY);
    }
  });

  it('is not kept, and each tool asks for the scope of its own service', async () => {
    const { gw, fetchImpl } = gatewayWith(
      {
        [`GET ${COLORS_URL}`]: { body: [] },
        [`GET ${LEADS_URL}`]: { body: { leads: [] } },
        [`GET ${BY_NUMBER_URL}`]: { body: { variants: [] } },
        [`POST ${SAVE_URL}`]: { body: operation(30) },
        [`PUT ${LEAD_URL}`]: { body: {} },
      },
      { policy: { enableWrites: true } },
    );
    await gw.callTool('list_car_options', { kind: 'colors' });
    await gw.callTool('list_car_options', { kind: 'colors' });
    await gw.callTool('list_leads', {});
    await gw.callTool('find_model', { number: 'AB12345' });
    await gw.callTool('save_car', CAR);
    await gw.callTool('update_lead', { leadId: LEAD_ID, status: 'Contacted' });
    const scopes = callsOf(fetchImpl)
      .filter(([url]) => url === SERVICES.token)
      .map(([, init]) => new URLSearchParams(String(init.body)).get('scope'));
    expect(scopes).toEqual([CARS_READ.scope, CARS_READ.scope, LEADS_READ.scope, MODELS_DRILL_DOWN.scope, CARS_WRITE.scope, LEADS_WRITE.scope]);
  });

  it('says in Danish when Bilinfo will not issue one, without the vendor text, and makes no further request', async () => {
    for (const status of [400, 401, 403]) {
      const { gw, fetchImpl } = gatewayWith({
        [`POST ${SERVICES.token}`]: { status, body: { error: 'invalid_scope', error_description: `unknown client ${CLIENT_ID}` } },
      });
      const result = await gw.callTool('list_leads', {});
      expect(result.isError).toBe(true);
      expect(result.failure).toEqual({ httpStatus: status });
      const text = texts(result).join(' ');
      expect(text).toContain('Bilinfo gav ikke adgang med det klient-id og den hemmelighed');
      expect(text).not.toContain('invalid_scope');
      expect(text).not.toContain(CLIENT_ID);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('is never passed on: an answer that held a secret is redacted, and an unreadable token answer stops the call', async () => {
    const { gw } = gatewayWith({
      [`GET ${LEADS_URL}`]: { body: { leads: [{ ...lead(1), customer: { firstName: `Kode ${CLIENT_SECRET} ${SUBSCRIPTION_KEY}` } }] } },
    });
    const result = await gw.callTool('list_leads', {}, { caller: CLIENT_SECRET });
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(result)).not.toContain(SUBSCRIPTION_KEY);

    const unreadable = gatewayWith({ [`POST ${SERVICES.token}`]: { body: { token_type: 'Bearer' } } });
    const failed = await unreadable.gw.callTool('list_leads', {});
    expect(failed.isError).toBe(true);
    expect(texts(failed).join(' ')).toContain('Bilinfos adgangstjeneste');
    expect(unreadable.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('is only asked for by the tools that need it, and each pair of credentials works without the other', async () => {
    const fetchImpl = stubFetch({ ...TOKEN_ROUTE, [`GET ${LEADS_URL}`]: { body: { leads: [] } } });
    const clientOnly = createBilinfoGateway({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      serviceUrls: SERVICES,
      allowCustomBaseUrl: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await clientOnly.callTool('list_leads', {})).isError).toBeUndefined();
    // Without a subscription key none is sent.
    expect(headerOf(notToken(fetchImpl)[0], SUBSCRIPTION_KEY_HEADER)).toBeUndefined();
    const vehicles = await clientOnly.callTool('stock_overview', {});
    expect(vehicles.isError).toBe(true);
    expect(texts(vehicles).join(' ')).toContain('brugernavn og adgangskode til Bilinfo mangler');

    const listingOnly = gatewayWith({}, { clientId: undefined, clientSecret: undefined });
    const leads = await listingOnly.gw.callTool('list_leads', {});
    expect(leads.isError).toBe(true);
    expect(texts(leads).join(' ')).toContain('klient-id og hemmelighed fra Bilinfo mangler');
    expect(listingOnly.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a car', () => {
  it('is not sent unless changes are turned on for the instance', async () => {
    const records: Array<Record<string, unknown>> = [];
    const { gw, fetchImpl } = gatewayWith({}, { policy: { audit: record => void records.push(record) } });
    const result = await gw.callTool('save_car', CAR);
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('Ændringer er ikke slået til');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records.map(record => record.action)).toEqual(['policy_denied']);
  });

  it("is sent once, as the whole car, to the instance's own dealer, with a version that only grows", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T08:00:00Z'));
    try {
      const records: Array<Record<string, unknown>> = [];
      const { gw, fetchImpl } = gatewayWith(
        { [`POST ${SAVE_URL}`]: { body: operation(10) } },
        { policy: { enableWrites: true, audit: record => void records.push(record) } },
      );
      const input = {
        ...CAR,
        description: 'Velholdt. Ny service.',
        pictures: [PICTURE],
        colorId: COLOR,
        leasing: { monthlyPayment: 3495, durationMonths: 36, type: 'Operational' as const },
        visibility: 'Internal' as const,
        timingBelt: { replaced: 'Yes' as const, date: '2025-06-01' },
      };
      const result = await gw.callTool('save_car', input, { caller: 'person-1', requestId: 'r1' });
      expect(result.isError, texts(result).join(' ')).toBeUndefined();
      const version = Math.floor(Date.parse('2026-11-27T08:00:00Z') / 1000);
      expect(result.structuredContent).toEqual({
        carId: 'LAGER-1001',
        version,
        visibility: 'Internal',
        operationId: '0d0d0d0d-1111-4222-8333-444444444444',
        status: 10,
        text: OPERATION_TEXTS[10],
      });
      // Bilinfo's own message is never passed on.
      expect(JSON.stringify(result)).not.toContain('tekst fra Bilinfo');

      const [token, post] = callsOf(fetchImpl);
      expect(new URLSearchParams(String(token?.[1].body)).get('scope')).toBe(CARS_WRITE.scope);
      expect(post?.[0]).toBe(SAVE_URL);
      expect(post?.[1].method).toBe('POST');
      expect(headerOf(post, 'Content-Type')).toBe('application/json');
      expect(JSON.parse(String(post?.[1].body))).toEqual({
        carId: 'LAGER-1001',
        variantId: VARIANT,
        version,
        mileage: 42000,
        isFactoryNew: false,
        registrationDate: '2021-03-14T00:00:00',
        description: 'Velholdt. Ny service.',
        pictures: [PICTURE],
        colorId: COLOR,
        visibility: 'Internal',
        timingBelt: { replaced: 'Yes', date: '2025-06-01T00:00:00' },
        prices: [
          { type: 'CashPrice', details: { price: 189900 } },
          { type: 'LeasingPrice', details: { leasePayment: 3495, duration: 36, type: 'Operational' } },
        ],
      });
      expect(records.map(record => record.action)).toEqual(['start', 'finish']);
      expect(records[0]).toMatchObject({ tool: 'bilinfo_save_car', caller: 'person-1', requestId: 'r1' });
      expect(JSON.stringify(records)).not.toContain('Velholdt');

      // A version given by the caller is used as it is.
      await gw.callTool('save_car', { ...CAR, version: 7 });
      expect(JSON.parse(String(callsOf(fetchImpl)[3]?.[1].body)).version).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is refused in our own words when Bilinfo answers with a status that means it was not made', async () => {
    for (const status of [41, 64, 73, 78, 99]) {
      const { gw } = gatewayWith({ [`POST ${SAVE_URL}`]: { body: operation(status) } }, { policy: { enableWrites: true } });
      const result = await gw.callTool('save_car', CAR);
      expect(result.isError, String(status)).toBe(true);
      const text = texts(result).join(' ');
      expect(text).toContain(`Bilinfos kode ${status}`);
      if (OPERATION_TEXTS[status]) expect(text).toContain(OPERATION_TEXTS[status]);
      expect(text).not.toContain('tekst fra Bilinfo');
    }
    const odd = gatewayWith({ [`POST ${SAVE_URL}`]: { body: { message: 'noget andet' } } }, { policy: { enableWrites: true } });
    const unreadable = await odd.gw.callTool('save_car', CAR);
    expect(unreadable.isError).toBe(true);
    expect(texts(unreadable).join(' ')).toContain('Det er uvist, om ændringen er modtaget');
  });

  it('is never sent twice, not without a log, not without a dealer, and never for another dealer', async () => {
    const failing = gatewayWith(
      { [`POST ${SAVE_URL}`]: { body: operation(30) } },
      {
        policy: {
          enableWrites: true,
          audit: () => {
            throw new Error('log is down');
          },
        },
      },
    );
    const unlogged = await failing.gw.callTool('save_car', CAR);
    expect(unlogged.isError).toBe(true);
    expect(texts(unlogged).join(' ')).toContain('Loggen kan ikke skrives');
    expect(failing.fetchImpl).not.toHaveBeenCalled();

    const busy = gatewayWith(
      { [`POST ${SAVE_URL}`]: { status: 503, body: {} } },
      { policy: { enableWrites: true }, maxAttempts: 3, retryBaseDelayMs: 0 },
    );
    const result = await busy.gw.callTool('save_car', CAR);
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 503 });
    expect(notToken(busy.fetchImpl)).toHaveLength(1);

    const open = gatewayWith({}, { dealerId: undefined, policy: { enableWrites: true } });
    const refused = await open.gw.callTool('save_car', CAR);
    expect(texts(refused).join(' ')).toContain('ikke sat op til en bestemt forhandler');
    expect(open.fetchImpl).not.toHaveBeenCalled();

    const { gw, fetchImpl } = gatewayWith({}, { policy: { enableWrites: true } });
    const other = await gw.callTool('save_car', { ...CAR, dealerId: NORDKYST.DealerGuid } as never);
    expect(other.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('takes only pictures Bilinfo already has, real dates and ids from Bilinfo', async () => {
    const { gw, fetchImpl } = gatewayWith({}, { policy: { enableWrites: true } });
    for (const bad of [
      { ...CAR, pictures: ['https://billeder.example/bil.jpg'] },
      { ...CAR, pictures: ['http://billeder.bilinfo.net/bil.jpg'] },
      { ...CAR, pictures: ['https://bruger:kode@billeder.bilinfo.net/bil.jpg'] },
      { ...CAR, registrationDate: '2021-02-30' },
      { ...CAR, registrationDate: '14-03-2021' },
      { ...CAR, variantId: 'Octavia' },
      { ...CAR, cashPrice: -1 },
      { ...CAR, visibility: 'Hidden' },
      { ...CAR, description: 'x'.repeat(4001) },
    ]) {
      const result = await gw.callTool('save_car', bad as never);
      expect(result.isError, JSON.stringify(bad).slice(0, 120)).toBe(true);
      expect(texts(result).join(' ')).toContain('Ugyldigt input');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is marked as sold once, with the kind of sale and the price', async () => {
    const { gw, fetchImpl } = gatewayWith({ [`POST ${SELL_URL}`]: { body: operation(30) } }, { policy: { enableWrites: true } });
    const result = await gw.callTool('mark_car_sold', { carId: 'LAGER-1001', soldTo: 'business', salesPrice: 150000 });
    expect(result.isError, texts(result).join(' ')).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ carId: 'LAGER-1001', status: 30 });
    const [, post] = callsOf(fetchImpl);
    expect(post?.[0]).toBe(SELL_URL);
    expect(JSON.parse(String(post?.[1].body))).toEqual({ carId: 'LAGER-1001', salesPriceType: 'Wholesale', salesPrice: 150000 });

    await gw.callTool('mark_car_sold', { carId: 'LAGER-1002', soldTo: 'private' });
    expect(JSON.parse(String(callsOf(fetchImpl)[3]?.[1].body))).toEqual({ carId: 'LAGER-1002', salesPriceType: 'Retail' });
  });

  it('is never changed for a person the host names: Bilinfo has no users to act as', async () => {
    const { gw, fetchImpl } = gatewayWith({ [`POST ${SAVE_URL}`]: { body: operation(30) } }, { policy: { enableWrites: true } });
    const result = await gw.callTool('save_car', CAR, { actAs: { email: 'saelger@fjordbybiler.example' } });
    expect(result.isError).toBe(true);
    expect(result.actAsRefused).toBe('not_permitted');
    expect(fetchImpl).not.toHaveBeenCalled();
    // A read goes as the connection.
    const read = gatewayWith({ [`GET ${COLORS_URL}`]: { body: [] } });
    const answer = await read.gw.callTool('list_car_options', { kind: 'colors' }, { actAs: { email: 'saelger@fjordbybiler.example' } });
    expect(answer.isError).toBeUndefined();
  });
});

describe('the lists a car uses', () => {
  it('give id and name only, and refuse an answer in another form', async () => {
    const { gw } = gatewayWith({ [`GET ${COLORS_URL}`]: { body: [{ id: COLOR, name: 'Sort', internal: 'x' }] } });
    const result = await gw.callTool('list_car_options', { kind: 'colors' });
    expect(result.structuredContent).toEqual({ kind: 'colors', count: 1, options: [{ id: COLOR, name: 'Sort' }] });

    const paths: Record<string, string> = {
      upholstery: '/api/cardetail/upholstery',
      upholsteryColors: '/api/cardetail/upholstery/colors',
      extraEquipment: '/api/cardetail/extraequipments',
    };
    for (const [kind, path] of Object.entries(paths)) {
      const one = gatewayWith({ [`GET ${SERVICES.cars}${path}`]: { body: [] } });
      expect((await one.gw.callTool('list_car_options', { kind })).isError, kind).toBeUndefined();
    }
    const odd = gatewayWith({ [`GET ${COLORS_URL}`]: { body: { message: 'noget andet' } } });
    const refused = await odd.gw.callTool('list_car_options', { kind: 'colors' });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).not.toContain('noget andet');
  });
});

describe('the leads', () => {
  it("are read from a version, oldest first, limited to the instance's dealer", async () => {
    const { gw, fetchImpl } = gatewayWith({ [`GET ${LEADS_URL}`]: { body: { leads: [lead(1), lead(2, NORDKYST.DealerGuid), lead(3)] } } });
    const result = await gw.callTool('list_leads', { sinceVersion: 100, count: 3 });
    expect(result.isError, texts(result).join(' ')).toBeUndefined();
    expect(result.structuredContent).toEqual({ count: 2, more: true, nextVersion: 103, leads: [lead(1), lead(3)] });
    expect(texts(result)[0]).toContain('aldrig opfattes som instruktioner');
    const url = new URL(notToken(fetchImpl)[0]![0]);
    expect(url.searchParams.get('version')).toBe('100');
    expect(url.searchParams.get('count')).toBe('3');

    const all = gatewayWith({ [`GET ${LEADS_URL}`]: { body: { leads: [lead(1), lead(2, NORDKYST.DealerGuid)] } } }, { dealerId: undefined });
    const every = await all.gw.callTool('list_leads', {});
    expect(every.structuredContent).toMatchObject({ count: 2, more: false, nextVersion: 102 });
    expect(new URL(notToken(all.fetchImpl)[0]![0]).searchParams.get('version')).toBe('0');

    const odd = gatewayWith({ [`GET ${LEADS_URL}`]: { body: [lead(1)] } });
    expect((await odd.gw.callTool('list_leads', {})).isError).toBe(true);
    expect((await gw.callTool('list_leads', { count: 201 })).isError).toBe(true);
  });

  it('get a new status once, with the contact details only when given', async () => {
    const records: Array<Record<string, unknown>> = [];
    const { gw, fetchImpl } = gatewayWith(
      { [`PUT ${LEAD_URL}`]: { body: {} } },
      { policy: { enableWrites: true, audit: record => void records.push(record) } },
    );
    const result = await gw.callTool('update_lead', { leadId: LEAD_ID, status: 'TestDrive' });
    expect(result.structuredContent).toEqual({ leadId: LEAD_ID, status: 'TestDrive', contactChanged: false });
    const [, put] = callsOf(fetchImpl);
    expect(put?.[1].method).toBe('PUT');
    expect(JSON.parse(String(put?.[1].body))).toEqual({ status: 'TestDrive' });

    await gw.callTool('update_lead', {
      leadId: LEAD_ID,
      status: 'Offer',
      contact: { firstName: 'Test', phone: '00000009', zipCode: 9999, city: 'Fjordby' },
    });
    expect(JSON.parse(String(callsOf(fetchImpl)[3]?.[1].body))).toEqual({
      status: 'Offer',
      contactInformation: { firstName: 'Test', phone: '00000009', addressInformation: { zipCode: 9999, city: 'Fjordby' } },
    });
    // The log holds the lead's id, never the customer's details.
    expect(JSON.stringify(records)).toContain(LEAD_ID);
    expect(JSON.stringify(records)).not.toContain('00000009');

    for (const bad of [{ leadId: LEAD_ID, status: 'Deleted' }, { leadId: '../x', status: 'New' }, { leadId: LEAD_ID }]) {
      const refused = await gw.callTool('update_lead', bad as never);
      expect(refused.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(notToken(fetchImpl)).toHaveLength(2);
  });
});

describe('the model catalog', () => {
  it('looks up by number, or by make and model, and needs one of them', async () => {
    const answer = {
      selection: { make: 'Skoda', model: 'Octavia' },
      options: { years: [2020, 2021] },
      variants: [{ id: VARIANT, text: '1,5 TSi 150 Style DSG' }],
    };
    const { gw, fetchImpl } = gatewayWith({ [`GET ${BY_NUMBER_URL}`]: { body: answer }, [`GET ${DRILL_DOWN_URL}`]: { body: answer } });
    const byNumber = await gw.callTool('find_model', { number: 'AB12345' });
    expect(byNumber.structuredContent).toEqual({ ...answer, variantCount: 1 });
    expect(new URL(notToken(fetchImpl)[0]![0]).searchParams.get('number')).toBe('AB12345');

    await gw.callTool('find_model', { make: 'Skoda', model: 'Octavia', year: 2021 });
    const query = new URL(notToken(fetchImpl)[1]![0]).searchParams;
    expect(Object.fromEntries(query)).toEqual({ Make: 'Skoda', Model: 'Octavia', Year: '2021' });

    const none = await gw.callTool('find_model', {});
    expect(texts(none).join(' ')).toContain('Angiv en nummerplade');
    expect(notToken(fetchImpl)).toHaveLength(2);
  });
});

describe('the connection check', () => {
  it('says which parts the connection reaches, without passing on anything Bilinfo answered', async () => {
    const { gw, fetchImpl } = gatewayWith({
      [`GET ${SERVICES.cars}/api/cardetail/colors`]: { body: [{ id: COLOR, name: 'Sort' }] },
      [`GET ${LEADS_URL}`]: { status: 403, body: { message: 'tekst fra Bilinfo' } },
      [`GET https://listing.bilinfo.test/listingapi/api/export`]: { body: { Vehicles: [{ Make: 'Skoda' }] } },
    });
    const result = await gw.callTool('check_connection', {});
    expect(result.isError, texts(result).join(' ')).toBeUndefined();
    expect(result.structuredContent).toEqual({ dealer: true, listing: 'ok', cars: 'ok', leads: 'refused', models: 'ok' });
    expect(JSON.stringify(result)).not.toContain('Skoda');
    expect(JSON.stringify(result)).not.toContain('tekst fra Bilinfo');
    // No customer's lead is read: the version asked for is above every lead's, and only one at most.
    const leads = new URL(callsOf(fetchImpl).find(([url]) => url.startsWith(LEADS_URL))![0]);
    expect(Number(leads.searchParams.get('version'))).toBe(Number.MAX_SAFE_INTEGER);
    expect(leads.searchParams.get('count')).toBe('1');
    const listing = new URL(callsOf(fetchImpl).find(([url]) => url.includes('/api/export'))![0]);
    expect(listing.searchParams.get('sinceDays')).toBe('1');

    const listingOnly = gatewayWith({}, { clientId: undefined, clientSecret: undefined, dealerId: undefined });
    const partial = await listingOnly.gw.callTool('check_connection', {});
    expect(partial.structuredContent).toEqual({ dealer: false, listing: 'unavailable', cars: 'not_set_up', leads: 'not_set_up', models: 'not_set_up' });
  });
});

describe('addresses of the services', () => {
  it('are the ones Bilinfo publishes, per environment, and credentials go nowhere else', () => {
    expect(SERVICE_URLS.production.token).toBe('https://accounts.ecgh.dk/oauth/connect/token');
    expect(SERVICE_URLS.qa.token).toBe('https://accounts.qa01.ecgh.dk/oauth/connect/token');
    expect(SERVICE_URLS.qa.cars).toBe('https://publicapi.bilinfo.net/carapiqa');
    expect(SERVICE_URLS.qa.leads).toBe('https://publicapi.bilinfo.net/leadsapiqa');
    expect(SERVICE_URLS.qa.models).toBe('https://publicapi.bilinfo.net/modelcatalogqa');
    expect(UPSTREAM_HOST_SUFFIXES).toEqual(['bilinfo.net', 'ecgh.dk']);
    for (const urls of Object.values(SERVICE_URLS)) {
      for (const url of Object.values(urls)) {
        const host = new URL(url).hostname;
        expect(UPSTREAM_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`)), url).toBe(true);
      }
    }
    const fetchImpl = vi.fn();
    const qa = new BilinfoClient({ credentialEnv: { BILINFO_ENVIRONMENT: 'qa' }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(qa.buildUrl('/api/leads', undefined, 'leads')).toBe('https://publicapi.bilinfo.net/leadsapiqa/api/leads');
    expect(qa.baseUrl).toBe('https://publicapi.bilinfo.net/listingapiqa');

    expect(() => new BilinfoClient({ credentialEnv: {}, environment: 'test' as never })).toThrow('production or qa');
    let message = '';
    try {
      new BilinfoClient({ credentialEnv: {}, serviceUrls: { token: 'https://accounts.elsewhere.example/token' } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('serviceUrls.token');
    expect(message).not.toContain('elsewhere');
  });
});
