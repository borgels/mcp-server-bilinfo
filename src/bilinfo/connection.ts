/**
 * Which parts of Bilinfo the connection reaches: one small request per API,
 * and of each answer only whether it came. For a host that checks new
 * credentials before it keeps them, and for a person who asks what works.
 *
 * - Listing API: the vehicles created, changed or removed the last day
 *   (sinceDays=1), the smallest answer the API gives.
 * - Car API: the list of colours, which every car upload uses.
 * - Leads API: the leads above the highest version there can be, which is
 *   none: no customer's lead is read.
 * - Model Catalog: an access token for its scope. Its requests need a car to
 *   look up, so the token is the check.
 *
 * Nothing of an answer is passed on or kept: each part is `ok`, `refused`
 * (Bilinfo said no to the credentials or the scope), `not_set_up` (the
 * instance has no credentials for it: nothing was sent) or `unavailable`
 * (no answer, or an error at Bilinfo).
 */
import { BilinfoHttpError } from '../errors.js';
import { CAR_OPTION_PATHS, CARS_READ } from './cars.js';
import { MissingCredentialsError, type UpstreamClient } from './client.js';
import { LEADS_READ, LIST_LEADS_PATH } from './leads.js';
import { MODELS_DRILL_DOWN } from './models.js';
import { EXPORT_PATH } from './vehicles.js';

export type PartStatus = 'ok' | 'refused' | 'not_set_up' | 'unavailable';

/** Above every lead's version (the Leads API's version is a 64-bit number; this is the largest safe one). */
const NO_LEAD_VERSION = Number.MAX_SAFE_INTEGER;

async function statusOf(read: () => Promise<unknown>): Promise<PartStatus> {
  try {
    await read();
    return 'ok';
  } catch (error) {
    if (error instanceof MissingCredentialsError) return 'not_set_up';
    if (error instanceof BilinfoHttpError) {
      if (error.status === 401 || error.status === 403 || error.status === 400) return 'refused';
      return 'unavailable';
    }
    return 'unavailable';
  }
}

export async function checkConnection(client: UpstreamClient) {
  const [listing, cars, leads, models] = await Promise.all([
    statusOf(() => client.get(EXPORT_PATH, { sinceDays: 1, ...(client.dealerId ? { dealerId: client.dealerId } : {}) })),
    statusOf(() => client.get(CAR_OPTION_PATHS.colors, undefined, CARS_READ)),
    statusOf(() => client.get(LIST_LEADS_PATH, { version: NO_LEAD_VERSION, count: 1 }, LEADS_READ)),
    statusOf(() => client.probeToken(MODELS_DRILL_DOWN)),
  ]);
  return { dealer: client.dealerId !== undefined, listing, cars, leads, models };
}
