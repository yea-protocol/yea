/**
 * The calendar as a fetch handler: the same code runs on Cloudflare Workers, Bun and Deno.
 *   Bun:     bun examples/worker.ts        (serves the default export on :8787)
 *   Deno:    deno serve examples/worker.ts
 *   Workers: use this file as the worker entry
 * Note: this reference keeps proposals in memory, so on Workers pin state to a Durable Object.
 */
import { fetchHandler } from '@yea-protocol/sdk';
import { calendar } from './calendar.ts';

const runtime = globalThis as {
  process?: { env: Record<string, string | undefined> };
};
const env = runtime.process?.env ?? {};
const svc = calendar({ trust: env.YEA_TRUST?.split(',') ?? [] });

export default { port: Number(env.PORT ?? 8787), fetch: fetchHandler(svc) };
