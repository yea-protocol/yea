/** Calling the wrapped REST API: build the request, send it, and map its errors to YEA error codes. */
import { YeaError } from '../errors.js';
import type { ErrorCode } from '../types.js';
import type { Json } from './json.js';
import type { Op } from './operations.js';
import type { OpenApiOptions } from './options.js';

/** The upstream request an operation makes for the given params. */
export function buildRequest(baseUrl: string, op: Op, params: Json) {
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
export interface Upstream {
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
export async function callUpstream(up: Upstream, req: UpstreamRequest) {
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
