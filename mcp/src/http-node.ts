/**
 * `@yea-protocol/mcp/http/node`: serve an `httpApp` on Node, through the SDK's `serveFetch`.
 * Separate from `./http` so that one imports on runtimes without Node's http module.
 */
import type { Server } from 'node:http';
import { type FetchGate, serveFetch } from '@yea-protocol/sdk/node';
import { MAX_BODY } from './http.js';

export interface ServeHttpOptions {
  port: number;
  host: string;
  /** The largest request body (default MAX_BODY); over it, 413 before the app runs. */
  maxBody?: number;
  /** Checks before the body is read: pass `httpGate(...)` with the app's token and loopback. */
  gate?: FetchGate;
  /** Milliseconds a client has to send its whole request (default 30 000). */
  requestTimeout?: number;
  /** At most this many connections at once (default: no limit). */
  maxConnections?: number;
}

/**
 * Serve `app` on `host:port` until the process ends; resolves with the server once it's
 * listening. `gate` runs before the body is read, so a request without the token is refused
 * without reading its body. Request headers reach the app (Streamable HTTP needs them), as sent:
 * X-Forwarded-* included, unfiltered. A body over `maxBody` is answered 413 before the app runs.
 */
export function serveHttp(
  app: (req: Request) => Promise<Response>,
  o: ServeHttpOptions,
): Promise<Server> {
  return serveFetch(app, {
    ...o,
    maxBody: o.maxBody ?? MAX_BODY,
    headers: true,
  });
}
