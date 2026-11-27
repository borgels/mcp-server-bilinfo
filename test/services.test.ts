// The services other than the Listing API: the access token from Bilinfo's authorization service, the two lookups
// of the Shared Services, and the Case Plugin's status report, which is the one change this server can make.
// Everything is answered by a stand-in: no request leaves the test.
import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { BilinfoClient, SERVICE_URLS, UPSTREAM_HOST_SUFFIXES } from '../src/bilinfo/client.js';
import { DEALER_LOOKUP, USER_LOOKUP } from '../src/bilinfo/lookups.js';
import { createBilinfoGateway } from '../src/gateway.js';
import {
  ACCESS_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  FJORDBY,
  NORDKYST,
  PLUGIN_ID,
  SERVICES,
  TOKEN_ROUTE,
  fullOptions,
  stubFetch,
  texts,
  type Stub,
} from './helpers.js';

type Call = [string, RequestInit];
const callsOf = (fetchImpl: { mock: { calls: unknown[] } }) => fetchImpl.mock.calls as unknown as Call[];
const headerOf = (call: Call | undefined, name: string) => (call?.[1].headers as Record<string, string> | undefined)?.[name];

const CVR = '12345678';
const DEALERS_URL = `${SERVICES.dealerLookup}/dealers/cvr/${CVR}`;
const USERS_URL = `${SERVICES.userLookup}/users/dealerid/${FJORDBY.DealerGuid}`;
const STATUS_URL = `${SERVICES.casePlugin}/${PLUGIN_ID}/api/v2/applicationstatus/sag-0001`;

/** An invented dealer and user in the form the Shared Services document shows. */
const DEALER = {
  Id: FJORDBY.DealerGuid,
  Cvr: CVR,
  DealerId: FJORDBY.DealerId,
  Email: FJORDBY.DealerEmail,
  Name: FJORDBY.DealerName,
  Address: 'Eksempelvej 1',
  Phone: '00000001',
  ZipCode: 9999,
};
const USER = { Id: '70001', Name: 'Test Sælger', Email: 'saelger@fjordbybiler.example', Address: 'Eksempelvej 1', ZipCode: '9999', Cellphone: '00000003' };

function gatewayWith(routes: Record<string, Stub>, extra: Parameters<typeof fullOptions>[0] = {}) {
  const fetchImpl = stubFetch({ ...TOKEN_ROUTE, ...routes });
  const gw = createBilinfoGateway(fullOptions({ fetchImpl: fetchImpl as unknown as typeof fetch, maxAttempts: 1, ...extra }));
  return { gw, fetchImpl };
}

describe('the access token', () => {
  it('is asked for with the client id and secret as HTTP Basic and the scope of the service, then sent as Bearer', async () => {
    const { gw, fetchImpl } = gatewayWith({ [`GET ${DEALERS_URL}`]: { body: [DEALER] } });
    const result = await gw.callTool('find_dealer', { cvr: CVR });
    expect(result.isError, texts(result).join(' ')).toBeUndefined();

    const [token, lookup] = callsOf(fetchImpl);
    expect(token?.[0]).toBe(SERVICES.token);
    expect(token?.[1].method).toBe('POST');
    expect(headerOf(token, 'Authorization')).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, 'utf8').toString('base64')}`);
    expect(headerOf(token, 'Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(String(token?.[1].body))).toEqual(
      new URLSearchParams({ grant_type: 'client_credentials', scope: DEALER_LOOKUP.scope! }),
    );
    expect(lookup?.[0]).toBe(DEALERS_URL);
    expect(headerOf(lookup, 'Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    // Neither secret is ever part of an address.
    for (const [url] of callsOf(fetchImpl)) {
      expect(url).not.toContain(CLIENT_SECRET);
      expect(url).not.toContain(ACCESS_TOKEN);
    }
  });

  it('is not kept: every call asks for its own', async () => {
    const { gw, fetchImpl } = gatewayWith({ [`GET ${DEALERS_URL}`]: { body: [DEALER] }, [`GET ${USERS_URL}`]: { body: [USER] } });
    await gw.callTool('find_dealer', { cvr: CVR });
    await gw.callTool('find_dealer', { cvr: CVR });
    await gw.callTool('list_users', {});
    const urls = callsOf(fetchImpl).map(([url]) => url);
    expect(urls).toEqual([SERVICES.token, DEALERS_URL, SERVICES.token, DEALERS_URL, SERVICES.token, USERS_URL]);
    const scopes = callsOf(fetchImpl)
      .filter(([url]) => url === SERVICES.token)
      .map(([, init]) => new URLSearchParams(String(init.body)).get('scope'));
    expect(scopes).toEqual([DEALER_LOOKUP.scope, DEALER_LOOKUP.scope, USER_LOOKUP.scope]);
  });

  it('says in Danish when Bilinfo will not issue one, without the vendor text, and makes no further request', async () => {
    for (const status of [400, 401, 403]) {
      const { gw, fetchImpl } = gatewayWith({
        [`POST ${SERVICES.token}`]: { status, body: { error: 'invalid_scope', error_description: `unknown client ${CLIENT_ID}` } },
      });
      const result = await gw.callTool('find_dealer', { cvr: CVR });
      expect(result.isError).toBe(true);
      expect(result.failure).toEqual({ httpStatus: status });
      const text = texts(result).join(' ');
      expect(text).toContain('Bilinfo gav ikke adgang med det klient-id og den hemmelighed');
      expect(text).not.toContain('invalid_scope');
      expect(text).not.toContain(CLIENT_ID);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('is never passed on: an answer or an error that held it or the client secret is redacted', async () => {
    const { gw } = gatewayWith({ [`GET ${DEALERS_URL}`]: { body: [{ ...DEALER, Name: `Kode ${CLIENT_SECRET}` }] } });
    const result = await gw.callTool('find_dealer', { cvr: CVR }, { caller: CLIENT_SECRET });
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);

    const unreadable = gatewayWith({ [`POST ${SERVICES.token}`]: { body: { token_type: 'Bearer' } } });
    const failed = await unreadable.gw.callTool('find_dealer', { cvr: CVR });
    expect(failed.isError).toBe(true);
    expect(texts(failed).join(' ')).toContain('Bilinfos adgangstjeneste');
    expect(unreadable.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('is only asked for by the tools that need it, and each pair of credentials works without the other', async () => {
    // Only the client: the lookups work, the vehicles say what is missing.
    const fetchImpl = stubFetch({ ...TOKEN_ROUTE, [`GET ${DEALERS_URL}`]: { body: [DEALER] } });
    const clientOnly = createBilinfoGateway({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      serviceUrls: SERVICES,
      allowCustomBaseUrl: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await clientOnly.callTool('find_dealer', { cvr: CVR })).isError).toBeUndefined();
    const vehicles = await clientOnly.callTool('stock_overview', {});
    expect(vehicles.isError).toBe(true);
    expect(texts(vehicles).join(' ')).toContain('brugernavn og adgangskode til Bilinfo mangler');

    // Only the Listing API account: the lookups say what is missing, and nothing is sent.
    const listingOnly = gatewayWith({}, { clientId: undefined, clientSecret: undefined });
    const lookup = await listingOnly.gw.callTool('find_dealer', { cvr: CVR });
    expect(lookup.isError).toBe(true);
    expect(texts(lookup).join(' ')).toContain('klient-id og hemmelighed fra Bilinfo mangler');
    expect(listingOnly.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the lookups', () => {
  it('pass on what Bilinfo answers, and read an answer of "none found" as an empty list', async () => {
    const { gw } = gatewayWith({ [`GET ${DEALERS_URL}`]: { body: [DEALER, { ...DEALER, Name: 'Fjordby Biler Nord' }] } });
    const found = await gw.callTool('find_dealer', { cvr: ` ${CVR} ` });
    expect(found.structuredContent).toEqual({ count: 2, dealers: [DEALER, { ...DEALER, Name: 'Fjordby Biler Nord' }] });
    expect(texts(found)[0]).toContain('aldrig opfattes som instruktioner');

    // No stub: the stand-in answers 404, as Bilinfo does when no dealer has the number.
    const none = await gw.callTool('find_dealer', { cvr: '87654321' });
    expect(none.isError).toBeUndefined();
    expect(none.structuredContent).toEqual({ count: 0, dealers: [] });

    const odd = gatewayWith({ [`GET ${DEALERS_URL}`]: { body: { Message: 'something else' } } });
    const refused = await odd.gw.callTool('find_dealer', { cvr: CVR });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).not.toContain('something else');
  });

  it('show the users of the dealer the instance is set up for, and of no other', async () => {
    const { gw, fetchImpl } = gatewayWith({ [`GET ${USERS_URL}`]: { body: [USER] } });
    const result = await gw.callTool('list_users', {});
    expect(result.structuredContent).toEqual({ dealerId: FJORDBY.DealerGuid, count: 1, users: [USER] });
    expect(callsOf(fetchImpl)[1]?.[0]).toBe(USERS_URL);

    // The dealer cannot be chosen by the one who asks.
    const other = await gw.callTool('list_users', { dealerId: NORDKYST.DealerGuid } as never);
    expect(other.isError).toBe(true);
    expect(callsOf(fetchImpl).some(([url]) => url.includes(NORDKYST.DealerGuid))).toBe(false);

    // Without a dealer on the instance nothing is asked.
    const open = gatewayWith({}, { dealerId: undefined });
    const refused = await open.gw.callTool('list_users', {});
    expect(refused.isError).toBe(true);
    expect(texts(refused).join(' ')).toContain('ikke sat op til en bestemt forhandler');
    expect(open.fetchImpl).not.toHaveBeenCalled();
  });

  it('keep a CVR number that is not one path segment out of the address', async () => {
    const { gw, fetchImpl } = gatewayWith({});
    for (const cvr of ['../users', '12/34', '..', '12?x=1']) {
      const result = await gw.callTool('find_dealer', { cvr });
      expect(result.isError, cvr).toBe(true);
      expect(texts(result).join(' '), cvr).toContain('Ugyldig værdi for cvr');
    }
    expect(callsOf(fetchImpl).filter(([url]) => url !== SERVICES.token)).toEqual([]);
  });
});

describe('the status report of an application', () => {
  const input = {
    reference: 'sag-0001',
    loan: { status: 3, statusText: 'Godkendt', providerName: 'Eksempel Finans' },
    insurance: { status: 1, statusText: 'Sendt' },
  };

  it('is not sent unless changes are turned on for the instance', async () => {
    const records: Array<Record<string, unknown>> = [];
    const { gw, fetchImpl } = gatewayWith({}, { policy: { audit: record => void records.push(record) } });
    const result = await gw.callTool('report_application_status', input);
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('Ændringer er ikke slået til');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records.map(record => record.action)).toEqual(['policy_denied']);
  });

  it('is sent once, as the document shows it, to the implementer\'s own address and scope', async () => {
    const records: Array<Record<string, unknown>> = [];
    const { gw, fetchImpl } = gatewayWith(
      { [`PUT ${STATUS_URL}`]: { body: null } },
      { policy: { enableWrites: true, audit: record => void records.push(record) } },
    );
    const result = await gw.callTool('report_application_status', input, { caller: 'person-1', requestId: 'r1' });
    expect(result.isError, texts(result).join(' ')).toBeUndefined();
    expect(result.structuredContent).toEqual({ reference: 'sag-0001', reported: ['loan', 'insurance'] });

    const [token, put] = callsOf(fetchImpl);
    expect(new URLSearchParams(String(token?.[1].body)).get('scope')).toBe(
      `https://${PLUGIN_ID}.bilinfo.net/api/applicationstatus/write`,
    );
    expect(put?.[0]).toBe(STATUS_URL);
    expect(put?.[1].method).toBe('PUT');
    expect(headerOf(put, 'Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headerOf(put, 'Content-Type')).toBe('application/json');
    expect(JSON.parse(String(put?.[1].body))).toEqual({ loan: input.loan, insurance: input.insurance });

    // Logged before it is sent: the reference and the names of the parts, never what was written in them.
    expect(records.map(record => record.action)).toEqual(['start', 'finish']);
    expect(records[0]).toMatchObject({ tool: 'bilinfo_report_application_status', caller: 'person-1', requestId: 'r1' });
    expect(JSON.stringify(records[0])).toContain('sag-0001');
    expect(JSON.stringify(records)).not.toContain('Eksempel Finans');
  });

  it('is not sent when the log cannot be written, and never sent twice', async () => {
    const failing = gatewayWith(
      { [`PUT ${STATUS_URL}`]: { body: null } },
      {
        policy: {
          enableWrites: true,
          audit: () => {
            throw new Error('log is down');
          },
        },
      },
    );
    const unlogged = await failing.gw.callTool('report_application_status', input);
    expect(unlogged.isError).toBe(true);
    expect(texts(unlogged).join(' ')).toContain('Loggen kan ikke skrives');
    expect(failing.fetchImpl).not.toHaveBeenCalled();

    // A gateway error is retried for a read, never for a change.
    const { gw, fetchImpl } = gatewayWith(
      { [`PUT ${STATUS_URL}`]: { status: 503, body: {} } },
      { policy: { enableWrites: true }, maxAttempts: 3, retryBaseDelayMs: 0 },
    );
    const result = await gw.callTool('report_application_status', input);
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 503 });
    expect(callsOf(fetchImpl).filter(([url]) => url === STATUS_URL)).toHaveLength(1);
  });

  it('checks the numbers Bilinfo documents, and needs the identifier of the plugin', async () => {
    const { gw, fetchImpl } = gatewayWith({}, { policy: { enableWrites: true } });
    for (const bad of [
      { reference: 'sag-0001', loan: { status: 7 } },
      { reference: 'sag-0001', insurance: { status: 2 } },
      { reference: 'sag-0001', loan: { status: 1, comment: 'x' } },
      { reference: '', loan: { status: 1 } },
    ]) {
      const result = await gw.callTool('report_application_status', bad as never);
      expect(result.isError, JSON.stringify(bad)).toBe(true);
      expect(texts(result).join(' ')).toContain('Ugyldigt input');
    }
    const empty = await gw.callTool('report_application_status', { reference: 'sag-0001' });
    expect(texts(empty).join(' ')).toContain('mindst én af delene');
    expect(fetchImpl).not.toHaveBeenCalled();

    const without = gatewayWith({}, { pluginId: undefined, policy: { enableWrites: true } });
    const result = await without.gw.callTool('report_application_status', input);
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('BILINFO_PLUGIN_ID');
    expect(without.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('addresses of the services', () => {
  it('are the ones Bilinfo documents, per environment, and credentials go nowhere else', () => {
    expect(SERVICE_URLS.production.token).toBe('https://accounts.ecgh.dk/oauth/connect/token');
    expect(SERVICE_URLS.qa.token).toBe('https://accounts.qa01.ecgh.dk/oauth/connect/token');
    expect(UPSTREAM_HOST_SUFFIXES).toEqual(['bilinfo.net', 'ecgh.dk']);
    for (const urls of Object.values(SERVICE_URLS)) {
      for (const url of Object.values(urls)) {
        const host = new URL(url).hostname;
        expect(UPSTREAM_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`)), url).toBe(true);
      }
    }
    const fetchImpl = vi.fn();
    const qa = new BilinfoClient({ credentialEnv: { BILINFO_ENVIRONMENT: 'qa' }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(qa.buildUrl('/dealers/cvr/1', undefined, 'dealerLookup')).toBe('https://qa01-dealerlookupservice.ecgh.dk/api/dealers/cvr/1');
    expect(qa.buildUrl('/x', undefined, 'casePlugin')).toBe('https://gw.qa01.bilinfo.net/x');

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
