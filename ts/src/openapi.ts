/**
 * OpenAPI → YEA. Wrap any existing REST API as a YEA service:
 *   GET operations            → ASK capabilities (read-only, budgeted, Lens)
 *   POST/PUT/PATCH/DELETE     → INTENT capabilities whose proposal shows the exact request
 *                               (method, URL, body) as its effect; COMMIT performs it.
 * REST calls can't be undone generically, so wrapped writes are irreversible and are
 * never auto-committed. Grants, spend caps and consent all apply unchanged.
 */
import { YeaError } from './errors.js';
import type { Plan } from './plan.js';
import { type Service, service } from './service.js';
import type { Effect, ErrorCode, ParamSchema, Risk } from './types.js';

/** An arbitrary JSON object: an OpenAPI document or any node inside it. */
type Json = Record<string, unknown>;

/*
 * Minimal views of the OpenAPI nodes we read. The document is untrusted JSON, so every
 * field is optional and may be missing; reads go through `?.` exactly as for plain JSON.
 */
interface SchemaNode {
  type?: string;
  format?: string;
  enum?: unknown;
  items?: unknown;
  properties?: Json;
  required?: string[];
  readOnly?: boolean;
  description?: string;
}

interface ParameterNode {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
}

interface RequestBodyNode {
  required?: boolean;
  content?: Record<string, { schema?: unknown } | undefined>;
}

/** An OpenAPI operation object, as passed to the `risk` and `include` options. */
export interface OpenApiOperation extends Json {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: unknown;
}

interface PathItemNode extends Json {
  parameters?: unknown[];
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

const isObjectOrArray = (v: unknown): v is Json => !!v && typeof v === 'object';

/** `v?.[k]` for an unknown value (primitives box, as in plain JS). */
const prop = (v: unknown, k: string): unknown =>
  v === null || v === undefined ? undefined : (v as Json)[k];

function pluck(v: unknown, path: string): unknown {
  const [head, ...rest] = path.split('.');

  if (head.endsWith('[]')) {
    const arr = prop(v, head.slice(0, -2));

    if (!Array.isArray(arr)) {
      return null;
    }

    const vals = arr
      .map((x) => (rest.length ? pluck(x, rest.join('.')) : x))
      .filter((x) => x !== null && x !== undefined);

    return vals.join(', ');
  }

  const next = prop(v, head);

  return rest.length ? pluck(next, rest.join('.')) : (next ?? null);
}

const lastSegment = (path: string) => path.slice(path.lastIndexOf('.') + 1);

/** Split a projection entry into [output key, path]: `out=path`, else the path's last name. */
function projection(field: string): [string, string] {
  if (field.includes('=')) {
    const [key, path] = field.split('=');

    return [key, path];
  }

  const named = field.includes('[]') ? field.split('[]')[0] : field;

  return [lastSegment(named), field];
}

export function projectFields(data: unknown, fields: string[]): unknown {
  const one = (o: unknown) =>
    Object.fromEntries(
      fields.map((f) => {
        const [k, p] = projection(f);

        return [k, pluck(o, p)];
      }),
    );

  if (Array.isArray(data)) {
    return data.map(one);
  }

  if (isObjectOrArray(data) && Array.isArray(data.items)) {
    return {
      ...('total_count' in data ? { total: data.total_count } : {}),
      items: data.items.map(one),
    };
  }

  return isObjectOrArray(data) ? one(data) : data;
}

const WRITE: Record<string, Effect['op']> = {
  post: 'create',
  put: 'update',
  patch: 'update',
  delete: 'delete',
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'api';

/** Follow local `$ref` pointers (`#/…`), bounded against cycles. */
function resolve(spec: Json, v: unknown, depth = 0): unknown {
  if (!isObjectOrArray(v) || depth > 20) {
    return v;
  }

  const ref = v.$ref;

  if (typeof ref === 'string' && ref.startsWith('#/')) {
    const target = ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (o, k) => prop(o, k.replace(/~1/g, '/').replace(/~0/g, '~')),
        spec,
      );

    return resolve(spec, target, depth + 1);
  }

  return v;
}

/** `resolve`, viewing the result through one of the minimal node interfaces above. */
const resolveAs = <T>(spec: Json, v: unknown) =>
  resolve(spec, v) as T | undefined;

/** A short string enum as `a|b|c`, or undefined when it wouldn't read well. */
function enumType(values: unknown): string | undefined {
  if (
    Array.isArray(values) &&
    values.length &&
    values.length <= 12 &&
    values.every((x: unknown) => typeof x === 'string' && !x.includes('|'))
  ) {
    return values.join('|');
  }

  return undefined;
}

const stringType = (format?: string) =>
  format === 'date' ? 'date' : format === 'date-time' ? 'datetime' : 'string';

/** JSON Schema → compact type string (SPEC §4.1.1). Lossy by design. */
function typeOf(spec: Json, schema: unknown, depth = 0): string {
  const s = resolveAs<SchemaNode>(spec, schema) ?? {};
  const listed = enumType(s.enum);

  if (listed) {
    return listed;
  }

  switch (s.type) {
    case 'integer':
      return 'int';
    case 'number':
      return 'number';
    case 'boolean':
      return 'bool';
    case 'string':
      return stringType(s.format);
    case 'array':
      return depth < 2 ? `${typeOf(spec, s.items, depth + 1)}[]` : 'any';
    default:
      return 'any';
  }
}

/** First sentence of a description, cut at a word boundary: a hint for the model, not docs. */
const describe = (t: string, d?: string) => {
  let text = (d ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .split(/(?<=\.)\s/)[0]
    .replace(/\.$/, '');

  if (text.length > 48) {
    text = `${text.slice(0, 48).replace(/\s+\S*$/, '')}…`;
  }

  return text ? `${t} — ${text}` : t;
};

interface Op {
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

function operations(spec: Json, o: OpenApiOptions, prefix: string): Op[] {
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

/** The upstream request an operation makes for the given params. */
function buildRequest(baseUrl: string, op: Op, params: Json) {
  let path = op.path;

  for (const k of op.pathParams) {
    if (params[k] === undefined) {
      throw new YeaError('invalid_params', `missing path parameter \`${k}\``);
    }

    path = path.replace(`{${k}}`, encodeURIComponent(String(params[k])));
  }

  const url = new URL(baseUrl + path);

  for (const k of op.queryParams) {
    const v = params[k];

    if (v !== undefined) {
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
  }

  let body: unknown;

  if (op.bodyKeys === 'whole') {
    body = params.body;
  } else if (op.bodyKeys) {
    body = Object.fromEntries(
      op.bodyKeys
        .filter((k) => params[k] !== undefined)
        .map((k) => [k, params[k]]),
    );
  }

  return { url, body };
}

/** Map an upstream HTTP error status to the closest YEA error code. */
function errorCodeFor(status: number): ErrorCode {
  if (status === 404) {
    return 'not_found';
  }

  if (status === 401 || status === 403) {
    return 'forbidden';
  }

  if (status === 409) {
    return 'conflict';
  }

  if (status === 429) {
    return 'limit';
  }

  return status < 500 ? 'invalid_params' : 'unavailable';
}

/** JSON if the text parses, else the raw text; empty → null. */
function parseResponse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** What each registered capability needs to reach the upstream API. */
interface Upstream {
  baseUrl: string;
  o: OpenApiOptions;
  fetch: typeof fetch;
}

interface UpstreamRequest {
  method: string;
  url: URL;
  body: unknown;
}

async function send({ o, fetch }: Upstream, req: UpstreamRequest) {
  const hasBody = req.body !== undefined;

  try {
    return await fetch(req.url, {
      method: req.method.toUpperCase(),
      headers: {
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...o.headers,
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new YeaError(
      'unavailable',
      `upstream request failed: ${(e as Error).message}`,
      { retry: 5 },
    );
  }
}

/** Perform an upstream call; non-2xx responses become YeaErrors. */
async function callUpstream(up: Upstream, req: UpstreamRequest) {
  const res = await send(up, req);
  const data = parseResponse(await res.text());

  if (!res.ok) {
    const shown = typeof data === 'string' ? data : JSON.stringify(data);

    throw new YeaError(
      errorCodeFor(res.status),
      `upstream ${res.status}: ${shown.slice(0, 200)}`,
    );
  }

  return data;
}

const shape = (o: OpenApiOptions, op: Op, data: unknown) =>
  op.id && o.project?.[op.id] ? projectFields(data, o.project[op.id]) : data;

function addAsk(svc: Service, op: Op, up: Upstream) {
  svc.ask(op.name, {
    summary: op.summary,
    params: Object.keys(op.params).length ? op.params : undefined,
    run: async ({ params: p }) => {
      const { url } = buildRequest(up.baseUrl, op, p);

      return shape(
        up.o,
        op,
        await callUpstream(up, { method: 'get', url, body: undefined }),
      );
    },
  });
}

function addIntent(svc: Service, op: Op, up: Upstream) {
  const risk =
    up.o.risk?.(op.method, op.path, op.raw) ??
    (op.method === 'delete' ? 'medium' : 'low');

  svc.intent(op.name, {
    summary: op.summary,
    params: Object.keys(op.params).length ? op.params : undefined,
    risk,
    plan: ({ params: p }): Plan => {
      const { url, body } = buildRequest(up.baseUrl, op, p);
      const verb = op.method.toUpperCase();

      return {
        summary: `${verb} ${url.pathname + url.search}`,
        effects: [
          {
            op: WRITE[op.method] ?? 'other',
            target: `${url.host}${url.pathname}`,
            detail:
              body !== undefined
                ? `body ${JSON.stringify(body).slice(0, 160)}`
                : `${verb} request`,
          },
        ],
        risk,
        apply: async () =>
          shape(
            up.o,
            op,
            await callUpstream(up, { method: op.method, url, body }),
          ),
      };
    },
  });
}

interface InfoNode {
  title?: string;
  description?: string;
}

/** Build a YEA service from an OpenAPI 3 document (JSON object). */
export function fromOpenAPI(spec: Json, o: OpenApiOptions = {}): Service {
  const servers = spec.servers as { url?: string }[] | undefined;
  const baseUrl = (o.baseUrl ?? servers?.[0]?.url ?? '').replace(/\/$/, '');

  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error(
      'OpenAPI adapter needs an absolute baseUrl (spec has no absolute servers[0].url)',
    );
  }

  const host = new URL(baseUrl).host;
  const info = spec.info as InfoNode | undefined;
  const title = info?.title ?? host;
  const svc = service({
    id: o.id ?? host,
    name: title,
    summary: (info?.description ?? `${title} (via OpenAPI)`)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200),
    trust: o.trust ?? [],
  });
  const prefix = o.prefix ?? slug(title).split('_').slice(0, 2).join('_');
  const upstream = { baseUrl, o, fetch: o.fetch ?? fetch };

  for (const op of operations(spec, o, prefix)) {
    if (op.method === 'get') {
      addAsk(svc, op, upstream);
    } else {
      addIntent(svc, op, upstream);
    }
  }

  return svc;
}

/** Load a spec from a URL or file path (JSON; YAML only if you pass a parsed object). */
export async function loadOpenAPI(source: string): Promise<Json> {
  let text: string;

  if (/^https?:\/\//.test(source)) {
    const r = await fetch(source, { signal: AbortSignal.timeout(30_000) });

    if (!r.ok) {
      throw new Error(`fetching ${source}: HTTP ${r.status}`);
    }

    text = await r.text();
  } else {
    const { readFile } = await import('node:fs/promises');

    text = await readFile(source, 'utf8');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      'the OpenAPI document must be JSON (convert YAML first, e.g. with `npx js-yaml spec.yaml > spec.json`)',
    );
  }
}
