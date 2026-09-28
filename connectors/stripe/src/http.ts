/**
 * `--http <port>`: Streamable HTTP for one person (SPEC-mcp-ts: HTTP serves one person in v0).
 * `sub` must come from the transport's authentication, so every request carries a bearer token
 * (`YEA_HTTP_TOKEN`), and a request that has it is that person (`YEA_SUB`). Anything else gets
 * 401 before the MCP handler sees it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import {
  type AuthInfo,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';

export interface HttpAuth {
  /** The bearer token every request must carry: at least 32 characters. */
  token: string;
  /** Who a request with that token is. */
  sub: string;
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
 * the MCP handler with the person's `sub`.
 */
export function httpApp(
  factory: () => McpServer,
  o: HttpAuth & { loopback: boolean },
): (req: Request) => Promise<Response> {
  const handler = createMcpHandler(factory);
  const authInfo: AuthInfo = {
    token: 'verified',
    clientId: 'yea-stripe-http',
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

/** A Node request as a web Request. */
function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();

  for (const [k, v] of Object.entries(req.headers)) {
    for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
      headers.append(k, value);
    }
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

  return new Request(new URL(req.url ?? '/', 'http://localhost'), {
    method: req.method ?? 'GET',
    headers,
    ...(hasBody
      ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' }
      : {}),
  } as RequestInit);
}

/** Write a web Response to a Node response, streaming its body. */
function send(res: ServerResponse, r: Response) {
  res.writeHead(r.status, Object.fromEntries(r.headers));

  if (!r.body) {
    res.end();

    return;
  }

  Readable.fromWeb(r.body as never).pipe(res);
}

/** Serve on `host:port` until the process ends. Resolves with the server once it's listening. */
export function serveHttp(
  app: (req: Request) => Promise<Response>,
  o: { port: number; host: string },
): Promise<Server> {
  const server = createServer((req, res) => {
    app(toRequest(req)).then(
      (r) => {
        send(res, r);
      },
      () => {
        res.writeHead(500).end();
      },
    );
  });

  return new Promise((resolve) => {
    server.listen(o.port, o.host, () => {
      resolve(server);
    });
  });
}
