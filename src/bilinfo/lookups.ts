/**
 * Bilinfo Shared Services: the Dealer Lookup Service and the User Lookup
 * Service ("Bilinfo Shared Services (Integration)"). Both are single GET
 * endpoints that take a Bearer token for a read scope.
 *
 * Nothing is kept: each lookup asks Bilinfo and hands the answer on.
 */
import { BilinfoHttpError } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { ApiTarget, UpstreamClient } from './client.js';

/** Path templates, relative to each service's base URL. */
export const DEALERS_BY_CVR_PATH = '/dealers/cvr/{cvr}';
export const USERS_BY_DEALER_PATH = '/users/dealerid/{dealerId}';

/** The scopes are the ones the document gives; it gives no others per environment. */
export const DEALER_LOOKUP: ApiTarget = {
  service: 'dealerLookup',
  scope: 'https://dealerlookupservice.ecgh.dk/auth/read',
};
export const USER_LOOKUP: ApiTarget = {
  service: 'userLookup',
  scope: 'https://userlookupservice.ecgh.dk/auth/read',
};

/** In Danish: the person who asked reads them. */
export const UNEXPECTED_ANSWER = 'Bilinfo svarede i en form, der ikke kan læses som en liste.';
export const NO_DEALER =
  'Denne forbindelse er ikke sat op til en bestemt forhandler, så brugerne kan ikke vises (BILINFO_DEALER_ID).';

/**
 * Both lookups answer 404 when nothing was found (and the user lookup also
 * when the dealer does not exist): that is an empty list, not an error.
 */
async function listOrEmpty(read: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  let answer: unknown;
  try {
    answer = await read();
  } catch (error) {
    if (error instanceof BilinfoHttpError && error.status === 404) {
      return [];
    }
    throw error;
  }
  if (!Array.isArray(answer) || answer.some(entry => entry === null || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new Error(UNEXPECTED_ANSWER);
  }
  return answer as Array<Record<string, unknown>>;
}

/** The dealers registered with a CVR number: one per outlet. The fields are Bilinfo's own, passed on as they are. */
export async function findDealers(client: UpstreamClient, cvr: string) {
  const dealers = await listOrEmpty(() =>
    client.get(`/dealers/cvr/${encodePathParam(cvr, 'cvr')}`, undefined, DEALER_LOOKUP),
  );
  return { count: dealers.length, dealers };
}

/**
 * The users (sales people) of the dealer the instance is set up for, and of no other. The client that asks is
 * registered for the integrating party, not for one dealer, so Bilinfo would answer for any dealer id: the dealer
 * is therefore never taken from a tool's input.
 */
export async function listUsers(client: UpstreamClient) {
  const id = client.dealerId;
  if (!id) {
    throw new Error(NO_DEALER);
  }
  const users = await listOrEmpty(() =>
    client.get(`/users/dealerid/${encodePathParam(id, 'dealerId')}`, undefined, USER_LOOKUP),
  );
  return { dealerId: id, count: users.length, users };
}
