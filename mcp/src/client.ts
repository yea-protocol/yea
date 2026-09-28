/**
 * Can the client ask (SPEC-mcp-ts, "Can the client ask?"). This follows the SDK's own check, so
 * we never return an `inputRequired` the SDK would then refuse.
 *
 * SDK seams: 2.1.0 types `ctx.mcpReq.envelope` loosely, so the capabilities key is read through a
 * narrow cast; on the 2025 era the capabilities come from `initialize`, through the deprecated
 * `getClientCapabilities()`, which is the SDK's own source for that era.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `elicitation.form`, or a bare `elicitation: {}` (the pre-mode meaning), means form support. */
export function canElicitForm(caps: unknown): boolean {
  const e = isObject(caps) ? caps.elicitation : undefined;

  if (!isObject(e)) {
    return false;
  }

  return e.form !== undefined || e.url === undefined;
}

/** The capabilities this request was made with, by era; undefined when there are none. */
export function clientCapabilities(
  server: McpServer,
  ctx: ServerContext,
): unknown {
  const envelope = ctx.mcpReq.envelope as Obj | undefined;

  // A 2026-07-28 request carries its own capabilities; use only those.
  if (envelope !== undefined) {
    return envelope[CLIENT_CAPABILITIES_META_KEY];
  }

  // A 2025-era request: what the client declared at `initialize`. A legacy stateless HTTP
  // request never saw `initialize`, so this is undefined and the client can't ask.
  return server.server.getClientCapabilities();
}

/** Whether this call may return a form-mode elicitation. */
export const canAsk = (server: McpServer, ctx: ServerContext) =>
  canElicitForm(clientCapabilities(server, ctx));
