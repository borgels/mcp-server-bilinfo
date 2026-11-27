/**
 * Bilinfo Model Catalog (developer.bilinfo.net, API "ModelCatalog", path
 * modelcatalogqa in QA): Bilinfo's own description of a car's make, model and
 * variant. A car in the Car API must carry the id of its variant from here.
 *
 * One lookup: by registration number or VIN (Bilinfo finds the variants that
 * fit the registered vehicle), or by type, make, model, year and fuel, where
 * the answer also says which choices remain at the next level.
 */
import type { ApiTarget, UpstreamClient } from './client.js';

/** The Model Catalog's scope for the drill-down (developer portal). */
export const MODELS_DRILL_DOWN: ApiTarget = { service: 'models', scope: 'https://modelcatalogpublic.ecgh.dk/auth/drill-down' };

/** Path templates, relative to the Model Catalog's base URL. */
export const DRILL_DOWN_PATH = '/api/drill-down';
export const DRILL_DOWN_BY_NUMBER_PATH = '/api/drill-down-by-reg-vin-number';

/** In Danish: the person who asked reads them. */
export const MODELS_UNREADABLE = 'Bilinfo svarede i en form, der ikke kan læses som et opslag i modelkataloget.';
export const NOTHING_TO_LOOK_UP = 'Angiv en nummerplade eller et stelnummer, eller mindst et mærke.';

export interface FindModelInput {
  number?: string;
  type?: string;
  make?: string;
  model?: string;
  year?: number;
  fuel?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Look a model up in Bilinfo's model catalog. The answer is Bilinfo's, passed on as it is. */
export async function findModel(client: UpstreamClient, input: FindModelInput) {
  let answer: unknown;
  if (input.number !== undefined) {
    answer = await client.get<unknown>(DRILL_DOWN_BY_NUMBER_PATH, { number: input.number }, MODELS_DRILL_DOWN);
  } else if (input.make !== undefined || input.type !== undefined) {
    answer = await client.get<unknown>(
      DRILL_DOWN_PATH,
      { Type: input.type, Make: input.make, Model: input.model, Year: input.year, Fuel: input.fuel },
      MODELS_DRILL_DOWN,
    );
  } else {
    throw new Error(NOTHING_TO_LOOK_UP);
  }
  if (!isRecord(answer)) {
    throw new Error(MODELS_UNREADABLE);
  }
  const variants = Array.isArray(answer.variants) ? answer.variants.filter(isRecord) : [];
  return {
    ...(isRecord(answer.selection) ? { selection: answer.selection } : {}),
    ...(isRecord(answer.options) ? { options: answer.options } : {}),
    ...(isRecord(answer.vehicleDetails) ? { vehicleDetails: answer.vehicleDetails } : {}),
    variantCount: variants.length,
    variants,
  };
}
