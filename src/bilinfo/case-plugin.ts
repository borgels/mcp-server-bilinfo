/**
 * Bilinfo Case Plugin, the part Bilinfo hosts ("Bilinfo Case Plugin
 * (Integration)" 3.0.0, chapter 6): the Application Status API, where the
 * implementer of a plugin (a finance or insurance company) reports the
 * status of an application back to the case in Bilinfo.
 *
 * It is a change in Bilinfo: one PUT, sent once.
 *
 * The same chapter documents a second endpoint, the sales contract as a PDF
 * file. It is not offered here: the answer is a binary document, and this
 * server only passes on text and data.
 */
import { encodePathParam } from '../path-params.js';
import type { ApiTarget, UpstreamClient } from './client.js';

/** Path template, relative to the gateway's base URL. `{pluginId}` is the identifier Bilinfo allots the implementer. */
export const APPLICATION_STATUS_PATH = '/{pluginId}/api/v2/applicationstatus/{reference}';

/** The service types Bilinfo documents ("Bilinfo Brands and Products (Integration)", table 3-5). */
export const SERVICE_TYPES = ['loan', 'leasing', 'insurance', 'roadSideAssistance'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

/** The status of one service type, as the document's example sends it. */
export interface ServiceStatus {
  providerName?: string;
  status: number;
  statusText?: string;
}

/** In Danish: the person who asked reads them. */
export const NO_PLUGIN =
  'Denne forbindelse er ikke sat op til at melde status på ansøgninger: det id, Bilinfo har givet sagsmodulet, mangler (BILINFO_PLUGIN_ID).';
export const NO_STATUS = 'Angiv status for mindst én af delene: lån, leasing, forsikring eller vejhjælp.';

/** The scope is per implementer, as the document writes it. */
export function applicationStatusTarget(pluginId: string): ApiTarget {
  return { service: 'casePlugin', scope: `https://${pluginId}.bilinfo.net/api/applicationstatus/write` };
}

export type ApplicationStatusInput = { reference: string } & Partial<Record<ServiceType, ServiceStatus>>;

/** Report the status of an application. Bilinfo documents no answer body, so the result is our own confirmation. */
export async function reportApplicationStatus(client: UpstreamClient, input: ApplicationStatusInput) {
  const { pluginId } = client;
  if (!pluginId) {
    throw new Error(NO_PLUGIN);
  }
  const body: Partial<Record<ServiceType, ServiceStatus>> = {};
  for (const type of SERVICE_TYPES) {
    const status = input[type];
    if (status !== undefined) body[type] = status;
  }
  const reported = Object.keys(body);
  if (reported.length === 0) {
    throw new Error(NO_STATUS);
  }
  await client.put(
    `/${encodePathParam(pluginId, 'pluginId')}/api/v2/applicationstatus/${encodePathParam(input.reference, 'reference')}`,
    body,
    applicationStatusTarget(pluginId),
  );
  return { reference: input.reference, reported };
}
