/**
 * Bilinfo Leads API (developer.bilinfo.net, API "Leads API", path leadsapiqa
 * in QA): the enquiries a dealer gets from Bilbasen, Bilinfo and DBA, and
 * their status in the dealer's sales work.
 *
 * Reading is one request that gives the leads with a version above a number,
 * oldest first, at most 200 at a time. A change sets a lead's status (and,
 * when given, the customer's contact details) with one PUT, sent once.
 *
 * The Leads API also has requests to create and delete a lead. They are not
 * offered: a lead comes from the customer, and deleting one removes its
 * history.
 *
 * A lead holds a customer's name, phone, email and message: it is passed on to
 * the caller as Bilinfo sends it and never kept.
 */
import { encodePathParam } from '../path-params.js';
import type { ApiTarget, UpstreamClient } from './client.js';

/** The Leads API's scopes (developer portal, each operation's "Authorization scope"). */
export const LEADS_READ: ApiTarget = { service: 'leads', scope: 'https://bin-leads.ecgh.dk/auth/read' };
export const LEADS_WRITE: ApiTarget = { service: 'leads', scope: 'https://bin-leads.ecgh.dk/auth/write' };

/** Path templates, relative to the Leads API's base URL. */
export const LIST_LEADS_PATH = '/api/leads';
export const UPDATE_LEAD_PATH = '/api/leads/{leadId}';

/** The statuses a lead can have (the Leads API's Status). */
export const LEAD_STATUSES = [
  'New',
  'Contacted',
  'TestDrive',
  'Offer',
  'Sold',
  'CaseCreated',
  'ContractNotePrinted',
  'ContractNoteSigned',
  'CarDelivered',
  'LeadLost',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Most leads per request, as the Leads API allows. */
export const MAX_LEADS = 200;

/** In Danish: the person who asked reads them. */
export const LEADS_UNREADABLE = 'Bilinfo svarede i en form, der ikke kan læses som en liste af kundehenvendelser.';
export const LEAD_NOT_FOUND =
  'Kundehenvendelsen blev ikke fundet med den version, eller den hører til en anden forhandler. Den kan være ændret, siden listen blev hentet: hent kundehenvendelserne igen, og brug id og version derfra. Intet blev ændret.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The leads with a version above `sinceVersion`, oldest first, limited to the instance's dealer when it has one.
 * `nextVersion` is the highest version in the answer: asking again from it gives the next leads.
 */
export async function listLeads(client: UpstreamClient, input: { sinceVersion?: number; count?: number }) {
  const sinceVersion = input.sinceVersion ?? 0;
  const answer = await client.get<unknown>(
    LIST_LEADS_PATH,
    { version: sinceVersion, count: input.count ?? MAX_LEADS },
    LEADS_READ,
  );
  const leads = isRecord(answer) ? answer.leads : undefined;
  if (!Array.isArray(leads) || !leads.every(isRecord)) {
    throw new Error(LEADS_UNREADABLE);
  }
  const versions = leads.map(lead => lead.version).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const nextVersion = versions.length > 0 ? Math.max(...versions) : sinceVersion;
  const dealer = client.dealerId;
  const mine = dealer
    ? leads.filter(lead => typeof lead.dealerId === 'string' && lead.dealerId.toLowerCase() === dealer)
    : leads;
  return {
    count: mine.length,
    // Bilinfo gives at most this many per request: when it gave that many, there may be more from nextVersion.
    more: leads.length >= (input.count ?? MAX_LEADS),
    nextVersion,
    leads: mine,
  };
}

/** Contact details of a lead's customer, as the Leads API takes them. */
export interface LeadContact {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  contactType?: 'Private' | 'Business';
  companyName?: string;
  address?: string;
  zipCode?: number;
  city?: string;
}

/**
 * The lead with this id and version, read from the Leads API before a change: the leads above version - 1 begin with
 * the one that has this version, as long as it has not changed since. It must be the lead with this id, and the
 * instance's dealer's when the instance has one. Otherwise nothing is changed.
 */
async function assertOwnLead(client: UpstreamClient, leadId: string, version: number): Promise<void> {
  const answer = await client.get<unknown>(LIST_LEADS_PATH, { version: version - 1, count: 1 }, LEADS_READ);
  const leads = isRecord(answer) ? answer.leads : undefined;
  if (!Array.isArray(leads)) {
    throw new Error(LEADS_UNREADABLE);
  }
  const [lead] = leads;
  const id = isRecord(lead) && typeof lead.id === 'string' ? lead.id.toLowerCase() : undefined;
  const dealer = isRecord(lead) && typeof lead.dealerId === 'string' ? lead.dealerId.toLowerCase() : undefined;
  if (
    !isRecord(lead) ||
    id !== leadId.toLowerCase() ||
    lead.version !== version ||
    (client.dealerId !== undefined && dealer !== client.dealerId)
  ) {
    throw new Error(LEAD_NOT_FOUND);
  }
}

/** Set a lead's status, and the customer's contact details when given. Sent once, after the lead is checked. */
export async function updateLead(
  client: UpstreamClient,
  input: { leadId: string; version: number; status: LeadStatus; contact?: LeadContact },
) {
  await assertOwnLead(client, input.leadId, input.version);
  const body: Record<string, unknown> = { status: input.status };
  if (input.contact) {
    const { address, zipCode, city, ...person } = input.contact;
    const addressInformation = Object.fromEntries(
      Object.entries({ address, zipCode, city }).filter(([, value]) => value !== undefined),
    );
    body.contactInformation = {
      ...Object.fromEntries(Object.entries(person).filter(([, value]) => value !== undefined)),
      ...(Object.keys(addressInformation).length > 0 ? { addressInformation } : {}),
    };
  }
  await client.put(`/api/leads/${encodePathParam(input.leadId, 'leadId')}`, body, LEADS_WRITE);
  return { leadId: input.leadId, status: input.status, contactChanged: input.contact !== undefined };
}
