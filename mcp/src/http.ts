/**
 * `@yea-protocol/mcp/http`: a Streamable HTTP front end for an MCP server that serves one person
 * (SPEC-mcp-ts: HTTP serves one person in v0). `sub` must come from the transport's
 * authentication, so every request carries a bearer token (`YEA_HTTP_TOKEN`), and a request that
 * has it is that person (`YEA_SUB`). Anything else gets 401 before the MCP handler sees it, and a
 * request body over `maxBody` gets 413. Fetch-level only (it needs `node:crypto`, which Bun, Deno
 * and Workers with `nodejs_compat` have); the Node server is in `./http/node`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type AuthInfo,
  createMcpHandler,
  localhostAllowedHostnames,
  type McpServer,
  type ServerContext,
  validateHostHeader,
} from '@modelcontextprotocol/server';

/** The largest request body served by default: 1 MiB, the same cap as a YEA frame. */
export const MAX_BODY = 1 << 20;

export interface HttpAuth {
  /** The bearer token every request must carry: at least 32 characters. */
  token: string;
  /** Who a request with that token is. */
  sub: string;
}

export interface HttpAppOptions extends HttpAuth {
  /** Listening on loopback only: check the `Host` header, against DNS rebinding. */
  loopback: boolean;
  /** The `clientId` in the `authInfo` the MCP handler gets. Default `yea-http`. */
  clientId?: string;
  /** The largest request body the MCP handler reads (default MAX_BODY); over it, 413. */
  maxBody?: number;
}

/** The HTTP settings from the environment; throws, saying what's missing. */
export function httpAuthFrom(env: NodeJS.ProcessEnv = process.env): HttpAuth {
  const token = env.YEA_HTTP_TOKEN ?? '';
  const sub = env.YEA_SUB ?? '';

  if (token.length < 32) {
    throw new Error(
      '--http needs YEA_HTTP_TOKEN, a bearer token of at least 32 characters that every request must carry',
    );
  }

  if (!sub) {
    throw new Error(
      '--http needs YEA_SUB, the identity of the one person this server acts for',
    );
  }

  return { token, sub };
}

/** Who is calling: the `sub` a verified request carries, else '' (which refuses the call). */
export function subOf(ctx: ServerContext): string {
  const sub = ctx.http?.authInfo?.extra?.sub;

  return typeof sub === 'string' ? sub : '';
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Compare in constant time, so the token can't be guessed a byte at a time. */
const sameToken = (a: string, b: string) =>
  timingSafeEqual(digest(a), digest(b));

/**
 * A Host that isn't loopback: 421 Misdirected Request, as the Python MCP SDK answers it (the TS
 * SDK's `hostHeaderValidationResponse` says 403). Undefined when the Host is fine.
 */
const misdirected = (req: Request) => {
  const host = validateHostHeader(
    req.headers.get('host'),
    localhostAllowedHostnames(),
  );

  return host.ok
    ? undefined
    : Response.json(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: host.message },
          id: null,
        },
        { status: 421 },
      );
};

const unauthorized = () =>
  new Response(JSON.stringify({ error: 'invalid_token' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer',
    },
  });

/**
 * The checks before anything else: on loopback the Host header (against DNS rebinding: 421),
 * then the bearer token, compared in constant time (401). Undefined lets the request through.
 * `httpApp` runs it on every request; pass it to `serveHttp` too, so it runs before the body is
 * read.
 */
export function httpGate(
  o: Pick<HttpAppOptions, 'token' | 'loopback'>,
): (req: Request) => Response | undefined {
  return (req) => {
    const badHost = o.loopback ? misdirected(req) : undefined;

    if (badHost) {
      return badHost;
    }

    const header = req.headers.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    return token && sameToken(token, o.token) ? undefined : unauthorized();
  };
}

/**
 * A fetch handler: `httpGate`, then the MCP handler with the person's `sub`. The MCP handler
 * caps the body it reads at `maxBody` too, so both checks hold on any runtime.
 */
export function httpApp(
  factory: () => McpServer,
  o: HttpAppOptions,
): (req: Request) => Promise<Response> {
  const gate = httpGate(o);
  const handler = createMcpHandler(factory, {
    maxRequestBodySize: o.maxBody ?? MAX_BODY,
  });
  const authInfo: AuthInfo = {
    token: 'verified',
    clientId: o.clientId ?? 'yea-http',
    scopes: [],
    extra: { sub: o.sub },
  };

  return async (req) => gate(req) ?? handler.fetch(req, { authInfo });
}
