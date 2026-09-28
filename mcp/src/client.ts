/**
 * Can the client ask (SPEC-mcp-ts, "Can the client ask?"). This follows the SDK's own check, so
 * we never return an `inputRequired` the SDK would then refuse.
 *
 * SDK seams: the era is the deprecated `getNegotiatedProtocolVersion()`, which is what the SDK
 * itself branches on; 2.1.0 types `ctx.mcpReq.envelope` loosely, so the capabilities key is read
 * through a narrow cast; on the 2025 era the capabilities come from `initialize`, through the
 * deprecated `getClientCapabilities()`, the SDK's own source for that era.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { isObject, type Obj } from './util.js';

/** `elicitation.form`, or a bare `elicitation: {}` (the pre-mode meaning), means form support. */
function canElicitForm(caps: unknown): boolean {
  const e = isObject(caps) ? caps.elicitation : undefined;

  if (!isObject(e)) {
    return false;
  }

  return e.form !== undefined || e.url === undefined;
}

/** The first protocol revision whose requests carry their own capabilities. */
const MODERN = '2026-07-28';

/**
 * Whether this server instance is serving the 2026-07-28 era: the SDK's own test
 * (`_servedModernEra`), on the negotiated revision. Revisions are dates, so they order as text.
 */
const servesModern = (server: McpServer) => {
  const v = server.server.getNegotiatedProtocolVersion();

  return v !== undefined && v >= MODERN;
};

/**
 * The capabilities this request was made with, by era, as the SDK's `_inputRequestCapabilityView`
 * reads them; undefined when there are none.
 */
function clientCapabilities(server: McpServer, ctx: ServerContext): unknown {
  // A 2026-07-28 request carries its own capabilities; use only those.
  if (servesModern(server)) {
    return (ctx.mcpReq.envelope as Obj | undefined)?.[
      CLIENT_CAPABILITIES_META_KEY
    ];
  }

  // A 2025-era request: what the client declared at `initialize`, whatever its envelope claims.
  // A legacy stateless HTTP request never saw `initialize`, so this is undefined: it can't ask.
  return server.server.getClientCapabilities();
}

/** Whether this call may return a form-mode elicitation. */
export const canAsk = (server: McpServer, ctx: ServerContext) =>
  canElicitForm(clientCapabilities(server, ctx));
