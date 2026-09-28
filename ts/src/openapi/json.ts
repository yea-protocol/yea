/** Reading untrusted JSON: the OpenAPI document and any node inside it. */

/** An arbitrary JSON object: an OpenAPI document or any node inside it. */
export type Json = Record<string, unknown>;

export const isObjectOrArray = (v: unknown): v is Json =>
  !!v && typeof v === 'object';

/** `v?.[k]` for an unknown value (primitives box, as in plain JS). */
export const prop = (v: unknown, k: string): unknown =>
  v === null || v === undefined ? undefined : (v as Json)[k];
