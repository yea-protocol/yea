/** The OpenAPI adapter's options, and the operation object its `risk` and `include` hooks see. */
import type { Risk } from '../types.js';
import type { Json } from './json.js';

/** An OpenAPI operation object, as passed to the `risk` and `include` options. */
export interface OpenApiOperation extends Json {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: unknown;
}

export interface OpenApiOptions {
  /** Base URL of the API (default: the spec's first server). */
  baseUrl?: string;
  /** Service id / audience (default: the API's host). */
  id?: string;
  /** Headers sent on every upstream call, e.g. { Authorization: "Bearer …" }. Never shown to the model. */
  headers?: Record<string, string>;
  /** Principals allowed to authorize writes. */
  trust?: string[] | ((principal: string) => boolean);
  /** Capability name prefix (default: a slug of the API title). */
  prefix?: string;
  /** Override the risk assessed for a write operation. Default: DELETE → medium, others low. */
  risk?: (method: string, path: string, op: OpenApiOperation) => Risk;
  /** Only expose operations for which this returns true. */
  include?: (method: string, path: string, op: OpenApiOperation) => boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Keep only these fields of an operation's response (keyed by operationId). Each entry is
   * `path` or `outKey=path`; `a.b` descends, `list[].x` maps over an array (joined with ", ").
   * Big upstream objects become compact Lens tables.
   */
  project?: Record<string, string[]>;
}
