/**
 * `@yea-protocol/mcp/http/node`: serve an `httpApp` on Node, through the SDK's `serveFetch`.
 * Separate from `./http` so that one imports on runtimes without Node's http module.
 */
import type { Server } from 'node:http';
import { type FetchGate, serveFetch } from '@yea-protocol/sdk/node';
import { MAX_BODY } from './http.js';
import {
  aFunction,
  aString,
  checkOptions,
  type Rule,
  required,
  whole,
} from './options.js';

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

/** One rule per key of `ServeHttpOptions` (SPEC-mcp-ts, "Closed options"), as `serveFetch` reads them. */
const SERVE_OPTIONS = {
  port: required({
    is: 'a port number, 0 to 65535',
    ok: (v) =>
      typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535,
  }),
  host: required(aString),
  maxBody: whole(0),
  gate: aFunction,
  requestTimeout: whole(1),
  maxConnections: whole(1),
} satisfies Record<keyof ServeHttpOptions, Rule>;

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
  checkOptions('serveHttp()', o, SERVE_OPTIONS);

  return serveFetch(app, {
    port: o.port,
    host: o.host,
    maxBody: o.maxBody ?? MAX_BODY,
    gate: o.gate,
    requestTimeout: o.requestTimeout,
    maxConnections: o.maxConnections,
    headers: true,
  });
}
