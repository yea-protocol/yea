/**
 * A fetch handler on Node's http module (`serveFetch`, exported from `@yea-protocol/sdk/node`),
 * with a gate before the body, a body cap, request timeouts and backpressure.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

/** A fetch-API handler: Workers, Bun, Deno, and Node through `serveFetch`. */
export type FetchApp = (req: Request) => Response | Promise<Response>;

/** A check before the body is read: a Response refuses the request, undefined lets it through. */
export type FetchGate = (
  req: Request,
) => Response | undefined | Promise<Response | undefined>;

export interface ServeFetchOptions {
  /** Default 8080. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /**
   * The most bytes a request body may have (default 1 MiB). A bigger one is answered 413 as soon
   * as it's declared or has arrived, and the app never sees it.
   */
  maxBody?: number;
  /**
   * Pass the request's headers to the app (default false: the app sees the method, the URL and
   * the body only). MCP's Streamable HTTP needs them: Authorization, Accept, Content-Type,
   * Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID and more. They arrive as sent, including
   * any X-Forwarded-* a client sets.
   */
  headers?: boolean;
  /**
   * Runs before the body is read, on a bodiless Request with the method, the URL and the
   * headers. A Response it returns is sent instead of running the app (an authentication
   * check, so a caller without credentials can't make the server read a body).
   */
  gate?: FetchGate;
  /** Milliseconds a client has to send the whole request, headers and body (default 30 000). */
  requestTimeout?: number;
  /** At most this many connections at once (default: no limit). */
  maxConnections?: number;
}

/** The default body cap: 1 MiB. */
export const MAX_REQUEST_BODY = 1 << 20;

/** How much more of a refused request's body is read, and thrown away, before hanging up. */
const DRAIN = 1 << 20;

/** How long a refused client that's still sending has to read the answer before it's cut off. */
const GRACE = 1000;

const REQUEST_TIMEOUT = 30_000;

interface Settings {
  max: number;
  tooLarge: string;
  headers: boolean;
  gate?: FetchGate;
  /** The client sent `Expect: 100-continue` and waits for our go-ahead before its body. */
  expectsContinue?: boolean;
}

/** `n` bytes, for a 413: "1 MiB", or a byte count when it isn't whole MiB. */
const sizeText = (n: number) =>
  n % (1 << 20) === 0 ? `${n / (1 << 20)} MiB` : `${n} bytes`;

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } });

/**
 * Stop reading, give the client GRACE to read the answer (its upload stalls on a full window
 * rather than failing), then close the connection.
 */
function hangUp(req: IncomingMessage) {
  req.pause();

  const timer = setTimeout(() => req.destroy(), GRACE);

  req.socket.once('close', () => clearTimeout(timer));
}

/**
 * Read and discard up to DRAIN more bytes of the request. A client that's done sending by then
 * gets the end of the response and a clean close; one that keeps sending is hung up on.
 */
function drainThenClose(req: IncomingMessage, res: ServerResponse) {
  if (req.readableEnded || req.destroyed) {
    res.end();

    return;
  }

  let left = DRAIN;
  const onData = (c: Buffer) => {
    left -= c.length;

    if (left < 0) {
      req.off('data', onData);
      hangUp(req);
    }
  };

  req.on('data', onData);
  req.once('end', () => res.end());
  req.resume(); // readCapped paused it
}

/**
 * Send `answer` instead of running the app: framed by Content-Length, so the client can read it
 * whole before the request is, with `connection: close`; then drain, and hang up. Without
 * `drain` (a client still waiting for 100 Continue, which hasn't sent its body), end at once.
 */
async function refuse(
  req: IncomingMessage,
  res: ServerResponse,
  answer: Response,
  drain = true,
) {
  const body = Buffer.from(await answer.arrayBuffer());

  if (res.headersSent) {
    res.end();

    return;
  }

  res.writeHead(answer.status, {
    ...Object.fromEntries(answer.headers),
    'content-length': String(body.length),
    connection: 'close',
  });
  res.write(body);

  if (drain) {
    drainThenClose(req, res);
  } else {
    res.end();
  }
}

/** The request declares a body over `max` bytes (Content-Length). */
const declaredOver = (req: IncomingMessage, max: number) =>
  Number(req.headers['content-length'] ?? 0) > max;

/**
 * Collect a request body, at most `max` bytes of it: null once it's over, by its declared
 * Content-Length before reading anything, else as soon as the bytes arrive. Nothing past `max`
 * is kept. Rejects if the request fails or closes before its end.
 */
function readCapped(
  req: IncomingMessage,
  max: number,
): Promise<Buffer<ArrayBuffer> | null> {
  if (declaredOver(req, max)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Pausing keeps what's read past the cap to the drain's exact bound.
    const done = () => {
      req.pause();
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onFail);
      req.off('close', onFail);
    };
    const onData = (c: Buffer) => {
      size += c.length;

      if (size > max) {
        done();
        resolve(null);
      } else {
        chunks.push(c);
      }
    };
    const onEnd = () => {
      done();
      resolve(Buffer.concat(chunks));
    };
    const onFail = () => {
      done();
      reject(new Error('the request ended early'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onFail);
    req.on('close', onFail);
  });
}

/** A Node request's headers as fetch Headers. */
function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();

  for (const [k, v] of Object.entries(req.headers)) {
    for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
      headers.append(k, value);
    }
  }

  return headers;
}

/** The request without its body: for the gate. Throws on a URL or method fetch can't take. */
function headOf(req: IncomingMessage): Request {
  // Never trust the Host header for parsing.
  const url = new URL(req.url ?? '/', 'http://localhost');

  return new Request(url, {
    method: req.method ?? 'GET',
    headers: headersOf(req),
  });
}

/**
 * The Request for the app, once the body is read. Its signal aborts if the client goes away
 * before the response is finished, so a long-lived stream can stop.
 */
function toRequest(
  head: Request,
  res: ServerResponse,
  o: { body: Buffer<ArrayBuffer>; headers: boolean },
): Request {
  const gone = new AbortController();
  const bodiless = head.method === 'GET' || head.method === 'HEAD';

  res.on('close', () => {
    if (!res.writableFinished) {
      gone.abort();
    }
  });

  return new Request(head.url, {
    method: head.method,
    signal: gone.signal,
    ...(o.headers ? { headers: head.headers } : {}),
    ...(bodiless ? {} : { body: o.body }),
  });
}

/**
 * Copy a fetch Response onto a Node response, respecting backpressure. If the client goes away,
 * the pipeline cancels the response body.
 */
async function relay(r: Response, res: ServerResponse) {
  res.writeHead(r.status, Object.fromEntries(r.headers));

  if (!r.body) {
    res.end();

    return;
  }

  await pipeline(
    Readable.fromWeb(r.body as unknown as NodeReadableStream<Uint8Array>),
    res,
  );
}

/** Answer `status` with no body, unless the response has already started. */
function fail(res: ServerResponse, status: number) {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-length': '0' });
  }

  res.end();
}

/** The gate's answer; a gate that throws refuses with 500. */
async function gateOf(gate: FetchGate | undefined, head: Request) {
  try {
    return gate ? await gate(head) : undefined;
  } catch {
    return text(500, 'internal error');
  }
}

/** Run the app on the request and relay its answer; an app that throws gets 500. */
async function runApp(app: FetchApp, request: Request, res: ServerResponse) {
  try {
    await relay(await app(request), res);
  } catch {
    fail(res, 500);
  }
}

/**
 * For `Expect: 100-continue`, once the gate has passed: 413 a declared body over the cap, else
 * send 100 Continue. True when the body may be read.
 */
async function goAhead(req: IncomingMessage, res: ServerResponse, o: Settings) {
  if (!o.expectsContinue) {
    return true;
  }

  if (declaredOver(req, o.max)) {
    await refuse(req, res, text(413, o.tooLarge), false);

    return false;
  }

  res.writeContinue();

  return true;
}

/**
 * One request: the gate (before any body is read, and before any 100 Continue), the body
 * (capped), then the app. A request that can't be parsed is answered 400.
 */
async function serveOne(
  app: FetchApp,
  req: IncomingMessage,
  res: ServerResponse,
  o: Settings,
) {
  let head: Request;

  try {
    head = headOf(req);
  } catch {
    await refuse(req, res, text(400, 'bad request'), !o.expectsContinue);

    return;
  }

  const stop = await gateOf(o.gate, head);

  if (stop) {
    await refuse(req, res, stop, !o.expectsContinue);

    return;
  }

  if (!(await goAhead(req, res, o))) {
    return;
  }

  let body: Buffer<ArrayBuffer> | null;

  try {
    body = await readCapped(req, o.max);
  } catch {
    fail(res, 400);

    return;
  }

  if (!body) {
    await refuse(req, res, text(413, o.tooLarge));

    return;
  }

  await runApp(app, toRequest(head, res, { body, headers: o.headers }), res);
}

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
