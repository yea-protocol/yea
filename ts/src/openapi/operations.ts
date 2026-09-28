/** The operations of an OpenAPI document, each with its capability name, params and request shape. */
import type { ParamSchema } from '../types.js';
import { type Json, prop } from './json.js';
import type { OpenApiOperation, OpenApiOptions } from './options.js';
import {
  describe,
  type ParameterNode,
  type RequestBodyNode,
  resolveAs,
  type SchemaNode,
  typeOf,
} from './schema.js';

interface PathItemNode extends Json {
  parameters?: unknown[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'api';

export interface Op {
  id?: string;
  raw: OpenApiOperation;
  method: string;
  path: string;
  name: string;
  summary: string;
  pathParams: string[];
  queryParams: string[];
  bodyKeys: string[] | 'whole' | null;
  params: ParamSchema;
}

/** Where an operation lives in the document. */
interface OpLocation {
  method: string;
  path: string;
  item: PathItemNode;
  op: OpenApiOperation;
}

/** The operationId if it is already a valid capability name, else a slug of it (or of method+path). */
const baseName = ({ method, path, op }: OpLocation) =>
  typeof op.operationId === 'string' &&
  /^[A-Za-z][A-Za-z0-9_]*$/.test(op.operationId)
    ? op.operationId
    : slug(op.operationId ?? `${method}_${path}`);

/** `prefix.base`, suffixed with 2, 3, … until it is unused; records the name as used. */
function claimName(used: Set<string>, prefix: string, base: string): string {
  let name = `${prefix}.${base}`;

  for (let i = 2; used.has(name); i++) {
    name = `${prefix}.${base}${i}`;
  }

  used.add(name);

  return name;
}

/** Add path and query parameters to `params`; returns their names by location. */
function urlParams(spec: Json, raw: unknown[], params: ParamSchema) {
  const pathParams: string[] = [];
  const queryParams: string[] = [];

  for (const r of raw) {
    const p = resolveAs<ParameterNode>(spec, r);

    if (!p?.name || (p.in !== 'path' && p.in !== 'query')) {
      continue;
    }

    (p.in === 'path' ? pathParams : queryParams).push(p.name);
    params[p.name + (p.required || p.in === 'path' ? '' : '?')] = describe(
      typeOf(spec, p.schema),
      p.description,
    );
  }

  return { pathParams, queryParams };
}

/**
 * Add the JSON request body to `params`: one param per writable property of an object
 * body, or a single `body` param otherwise. `urlKeys` are already carried by the URL.
 */
function bodyParams(
  spec: Json,
  op: OpenApiOperation,
  params: ParamSchema,
  urlKeys: string[],
): Op['bodyKeys'] {
  const body = resolveAs<RequestBodyNode>(spec, op.requestBody);
  const schema = resolveAs<SchemaNode>(
    spec,
    body?.content?.['application/json']?.schema,
  );

  if (!schema) {
    return null;
  }

  if (schema.type !== 'object' && !schema.properties) {
    params[body?.required ? 'body' : 'body?'] = describe(
      typeOf(spec, schema),
      'request body',
    );

    return 'whole';
  }

  const req = new Set<string>(schema.required ?? []);
  const keys: string[] = [];

  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    const property = resolveAs<SchemaNode>(spec, v);

    if (property?.readOnly || urlKeys.includes(k)) {
      continue;
    }

    keys.push(k);
    params[k + (req.has(k) ? '' : '?')] = describe(
      typeOf(spec, v),
      property?.description,
    );
  }

  return keys;
}

const opSummary = ({ method, path, op }: OpLocation) =>
  (op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);

function toOp(spec: Json, loc: OpLocation, name: string): Op {
  const params: ParamSchema = {};
  const { pathParams, queryParams } = urlParams(
    spec,
    [...(loc.item.parameters ?? []), ...(loc.op.parameters ?? [])],
    params,
  );
  const bodyKeys = bodyParams(spec, loc.op, params, [
    ...pathParams,
    ...queryParams,
  ]);

  return {
    id: loc.op.operationId,
    raw: loc.op,
    method: loc.method,
    path: loc.path,
    name,
    summary: opSummary(loc),
    pathParams,
    queryParams,
    bodyKeys,
    params,
  };
}

export function operations(
  spec: Json,
  o: OpenApiOptions,
  prefix: string,
): Op[] {
  const out: Op[] = [];
  const used = new Set<string>();
  const paths = (spec.paths ?? {}) as Record<string, PathItemNode | undefined>;

  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const op = prop(item, method) as OpenApiOperation | undefined;

      if (!item || !op || (o.include && !o.include(method, path, op))) {
        continue;
      }

      const loc = { method, path, item, op };

      out.push(toOp(spec, loc, claimName(used, prefix, baseName(loc))));
    }
  }

  return out;
}
