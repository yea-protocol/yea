/**
 * A fetch handler on Node's http module (`serveFetch`, exported from `@yea-protocol/sdk/node`),
 * with a gate before the body, a body cap, request timeouts and backpressure.
 * The per-request parts live in serve-fetch/; this file validates options and starts the server.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type {
  FetchApp,
  ServeFetchOptions,
  Settings,
} from './serve-fetch/options.js';
import { serveOne } from './serve-fetch/serve-one.js';

export type {
  FetchApp,
  FetchGate,
  ServeFetchOptions,
} from './serve-fetch/options.js';

/** The default body cap: 1 MiB. */
export const MAX_REQUEST_BODY = 1 << 20;

const REQUEST_TIMEOUT = 30_000;

/** `n` bytes, for a 413: "1 MiB", or a byte count when it isn't whole MiB. */
const sizeText = (n: number) =>
  n % (1 << 20) === 0 ? `${n / (1 << 20)} MiB` : `${n} bytes`;

/** Throw unless `n` is undefined or a whole number at least `min`. */
function checkWhole(name: string, n: number | undefined, min: number) {
  if (n !== undefined && (!Number.isSafeInteger(n) || n < min)) {
    throw new RangeError(`${name} must be a whole number ≥ ${min}, got ${n}`);
  }
}

/** Serve `app` on Node's http module, with the given 413 text. */
export function serveCapped(
  app: FetchApp,
  o: ServeFetchOptions,
  tooLarge: string,
): Promise<Server> {
  const timeout = o.requestTimeout ?? REQUEST_TIMEOUT;
  const settings: Settings = {
    max: o.maxBody ?? MAX_REQUEST_BODY,
    tooLarge,
    headers: o.headers ?? false,
    gate: o.gate,
  };
  const handle =
    (extra: Partial<Settings>) =>
    (req: IncomingMessage, res: ServerResponse) => {
      req.on('error', () => {
        // an aborted upload surfaces through the body read
      });
      void serveOne(app, req, res, { ...settings, ...extra });
    };
  const server = createServer(
    {
      requestTimeout: timeout,
      headersTimeout: timeout,
      // How often Node checks those timeouts (its default, 30 s, would double a short one).
      connectionsCheckingInterval: Math.min(timeout, 1000),
    },
    handle({}),
  );

  // Expect: 100-continue: the gate runs before the client is told to send its body.
  server.on('checkContinue', handle({ expectsContinue: true }));

  if (o.maxConnections !== undefined) {
    server.maxConnections = o.maxConnections;
  }

  return new Promise((resolve) =>
    server.listen(o.port ?? 8080, o.host ?? '127.0.0.1', () => resolve(server)),
  );
}

/**
 * Serve a fetch handler on Node's http module; resolves once listening.
 *
 * Per request: `gate` runs on the headers, before any body is read (and, for
 * `Expect: 100-continue`, before the client is told to send it). Then the body is read,
 * keeping at most `maxBody` bytes (a request in flight holds up to about twice that while it's
 * joined); a bigger one gets 413 and never reaches the app. A refused request's answer is framed
 * by Content-Length and `connection: close`; up to 1 MiB more of its body is read and discarded,
 * then the connection is closed. A client that takes longer than `requestTimeout` to send its
 * request is cut off. `maxConnections` bounds how many requests are in flight at once.
 */
export function serveFetch(
  app: FetchApp,
  o: ServeFetchOptions = {},
): Promise<Server> {
  const max = o.maxBody ?? MAX_REQUEST_BODY;

  checkWhole('maxBody', o.maxBody, 0);
  checkWhole('requestTimeout', o.requestTimeout, 1);
  checkWhole('maxConnections', o.maxConnections, 1);

  return serveCapped(app, o, `request body exceeds ${sizeText(max)}`);
}
