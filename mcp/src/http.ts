/**
 * `@yea-protocol/mcp/http`: a Streamable HTTP front end for an MCP server that serves one person
 * (SPEC-mcp-ts: HTTP serves one person in v0). `sub` must come from the transport's
 * authentication, so every request carries a bearer token (`YEA_HTTP_TOKEN`), and a request that
 * has it is that person (`YEA_SUB`). Anything else gets 401 before the MCP handler sees it, and a
 * request body over `maxBody` gets 413.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import {
  type AuthInfo,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { serveFetch } from '@yea-protocol/sdk/node';

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

const unauthorized = () =>
  new Response(JSON.stringify({ error: 'invalid_token' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer',
    },
  });

/**
 * A fetch handler: the Host check (on loopback, against DNS rebinding), the bearer token, then
 * the MCP handler with the person's `sub`. The MCP handler caps the body it reads at `maxBody`
 * too, so the cap holds on runtimes other than `serveHttp`.
 */
export function httpApp(
  factory: () => McpServer,
  o: HttpAppOptions,
): (req: Request) => Promise<Response> {
  const handler = createMcpHandler(factory, {
    maxRequestBodySize: o.maxBody ?? MAX_BODY,
  });
  const authInfo: AuthInfo = {
    token: 'verified',
    clientId: o.clientId ?? 'yea-http',
    scopes: [],
    extra: { sub: o.sub },
  };

  return async (req) => {
    const badHost = o.loopback
      ? hostHeaderValidationResponse(req, localhostAllowedHostnames())
      : undefined;

    if (badHost) {
      return badHost;
    }

    const header = req.headers.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token || !sameToken(token, o.token)) {
      return unauthorized();
    }

    return handler.fetch(req, { authInfo });
  };
}

/**
 * Serve `app` on `host:port` until the process ends; resolves with the server once it's
 * listening. Request headers reach the app (Streamable HTTP needs them); a body over `maxBody`
 * (default MAX_BODY) is answered 413 before the app runs, and never kept in full.
 */
export function serveHttp(
  app: (req: Request) => Promise<Response>,
  o: { port: number; host: string; maxBody?: number },
): Promise<Server> {
  return serveFetch(app, {
    port: o.port,
    host: o.host,
    maxBody: o.maxBody ?? MAX_BODY,
    headers: true,
  });
}
