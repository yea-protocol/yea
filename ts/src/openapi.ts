/**
 * OpenAPI → YEA. Wrap any existing REST API as a YEA service:
 *   GET operations            → ASK capabilities (read-only, budgeted, Lens)
 *   POST/PUT/PATCH/DELETE     → INTENT capabilities whose proposal shows the exact request
 *                               (method, URL, body) as its effect; COMMIT performs it.
 * REST calls can't be undone generically, so wrapped writes are irreversible and are
 * never auto-committed. Grants, spend caps and consent all apply unchanged.
 * The parts live in openapi/; this file builds the service and loads documents.
 */
import { addAsk, addIntent } from './openapi/capabilities.js';
import type { Json } from './openapi/json.js';
import { operations, slug } from './openapi/operations.js';
import type { OpenApiOptions } from './openapi/options.js';
import { type Service, service } from './service.js';

export type {
  OpenApiOperation,
  OpenApiOptions,
} from './openapi/options.js';

export { projectFields } from './openapi/project.js';

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
