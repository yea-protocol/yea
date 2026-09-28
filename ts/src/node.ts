/** Node transports: TCP (yea://), TLS (yeas://), stdio, and an HTTP bridge server. */
import { spawn } from 'node:child_process';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import {
  Client,
  type ClientOptions,
  http,
  lines,
  type Transport,
} from './client.js';
import { errorLine, frameId } from './frames.js';
import { fetchHandler } from './http.js';
import type { Service } from './service.js';

export const DEFAULT_PORT = 7447;

const DEFAULT_TLS_PORT = 7448;

const MAX_FRAME = 1 << 20;

const MAX_INFLIGHT = 64;

const errFrame = (message: string, code = 'bad_frame') =>
  errorLine({ id: 's_err', re: '?', code, message });

/** Parse one NDJSON line; null if it isn't JSON (the service answers that with an ERROR). */
function parseFrame(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * A `data` handler that splits NDJSON input into trimmed, non-empty lines. A frame over
 * MAX_FRAME is reported once via `onOversize` and skipped up to its terminating newline.
 */
function lineSplitter(
  onLine: (line: string) => void,
  onOversize: () => void,
): (chunk: string) => void {
  let buf = '';
  let discarding = false; // after an oversized frame, drop input until the next newline
  const take = (line: string) => {
    if (Buffer.byteLength(line) > MAX_FRAME) {
      onOversize();
    } else if (line) {
      onLine(line);
    }
  };
  const dropOverflow = () => {
    if (Buffer.byteLength(buf) <= MAX_FRAME) {
      return;
    }

    if (!discarding) {
      onOversize();
    }

    discarding = true;
    buf = '';
  };

  return (chunk) => {
    buf += chunk;

    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();

      buf = buf.slice(nl + 1);

      if (discarding) {
        discarding = false;
      } else {
        take(line);
      }
    }

    dropOverflow();
  };
}

/** Handle each line as a request frame, concurrently but at most MAX_INFLIGHT at a time. */
function frameHandler(svc: Service, send: (s: string) => void) {
  let inflight = 0;

  return (line: string) => {
    const frame = parseFrame(line);

    if (inflight >= MAX_INFLIGHT) {
      send(
        errorLine({
          id: 's_busy',
          re: frameId(frame),
          code: 'limit',
          message: `more than ${MAX_INFLIGHT} requests in flight on this connection`,
          retry: 1,
        }),
      );

      return;
    }

    inflight++;
    svc
      .handle(frame, (e) => send(`${JSON.stringify(e)}\n`))
      .then((r) => send(`${JSON.stringify(r)}\n`))
      .catch(() =>
        send(
          errorLine({
            id: 's_err',
            re: frameId(frame),
            code: 'internal',
            message: 'reply could not be serialized',
          }),
        ),
      )
      .finally(() => inflight--);
  };
}

/** Serve NDJSON frames on a duplex stream. Requests are handled concurrently, up to MAX_INFLIGHT. */
function serveStream(
  svc: Service,
  input: NodeJS.ReadableStream,
  write: (s: string) => void,
) {
  const send = (s: string) => {
    try {
      write(s);
    } catch {
      // the peer is gone; there is no one left to tell
    }
  };

  input.setEncoding?.('utf8');
  input.on('error', () => {
    // a broken input just stops producing data; keep the process alive
  });
  input.on(
    'data',
    lineSplitter(frameHandler(svc, send), () =>
      send(errFrame('frame exceeds 1 MiB')),
    ),
  );
}

/** Listen for yea:// (TCP) or, with `tls` options, yeas:// connections. */
export function listen(
  svc: Service,
  o: { port?: number; host?: string; tls?: tls.TlsOptions } = {},
): Promise<net.Server> {
  const onConn = (sock: net.Socket) => {
    sock.on('error', () => {
      // without a listener a client's socket error would crash the server; 'close' follows
    });
    serveStream(svc, sock, (s) => sock.writable && sock.write(s));
  };
  const server = o.tls
    ? tls.createServer(o.tls, onConn)
    : net.createServer(onConn);

  return new Promise((resolve) =>
    server.listen(
      o.port ?? (o.tls ? DEFAULT_TLS_PORT : DEFAULT_PORT),
      o.host ?? '127.0.0.1',
      () => resolve(server),
    ),
  );
}

/** Serve over this process's stdin/stdout (for locally spawned services). */
export function serveStdio(svc: Service) {
  serveStream(svc, process.stdin, (s) => process.stdout.write(s));
}

/** A fetch-API handler: Workers, Bun, Deno, and Node through `serveFetch`. */
export type FetchApp = (req: Request) => Response | Promise<Response>;

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
   * Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID and more.
   */
  headers?: boolean;
}

/** `n` bytes, for a 413: "1 MiB", or a byte count when it isn't whole MiB. */
const sizeText = (n: number) =>
  n % (1 << 20) === 0 ? `${n / (1 << 20)} MiB` : `${n} bytes`;

/** How much more of an oversized body is read, and thrown away, after the 413. */
const DRAIN = 1 << 20;

/**
 * Answer 413, then read and discard up to DRAIN more bytes, so a client that's nearly done
 * sending reads the answer instead of a reset. Past that, hang up.
 */
function refuse(req: IncomingMessage, res: ServerResponse, text: string) {
  let left = DRAIN;

  res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
  res.write(text);
  req.on('data', (c: Buffer) => {
    left -= c.length;

    if (left < 0) {
      req.destroy();
    }
  });
  req.on('end', () => res.end());
}

/**
 * Collect a request body, at most `max` bytes of it. Null (after answering 413) once it's over:
 * by its declared Content-Length before reading anything, else as soon as the bytes arrive.
 * Nothing past `max` is kept.
 */
function readCapped(
  req: IncomingMessage,
  res: ServerResponse,
  o: { max: number; tooLarge: string },
): Promise<Buffer<ArrayBuffer> | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const over = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      chunks.length = 0;
      refuse(req, res, o.tooLarge);
      resolve(null);
    };
    const onData = (c: Buffer) => {
      size += c.length;

      if (size > o.max) {
        over();
      } else {
        chunks.push(c);
      }
    };
    const onEnd = () => resolve(Buffer.concat(chunks));

    req.once('error', reject);
    req.once('close', () => reject(new Error('request closed')));

    if (Number(req.headers['content-length'] ?? 0) > o.max) {
      over();

      return;
    }

    req.on('data', onData);
    req.on('end', onEnd);
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

/**
 * The fetch Request for a Node request whose body has been read. Its signal aborts if the client
 * goes away before the response is finished, so a long-lived stream can stop.
 */
function toRequest(
  req: IncomingMessage,
  res: ServerResponse,
  o: { body: Buffer<ArrayBuffer>; headers: boolean },
): Request {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost'); // never trust the Host header for parsing
  const gone = new AbortController();

  res.on('close', () => {
    if (!res.writableFinished) {
      gone.abort();
    }
  });

  return new Request(url, {
    method,
    signal: gone.signal,
    ...(o.headers ? { headers: headersOf(req) } : {}),
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: o.body }),
  });
}

/** Copy a fetch Response onto a Node response, streaming the body. */
async function relay(r: Response, res: ServerResponse) {
  res.writeHead(r.status, Object.fromEntries(r.headers));

  // Node's web streams are async-iterable; the DOM lib typings just don't say so.
  if (r.body) {
    for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
      res.write(c);
    }
  }

  res.end();
}

/** Answer `status` with no body, unless the response has already started. */
function fail(res: ServerResponse, status: number) {
  if (!res.headersSent) {
    res.writeHead(status);
  }

  res.end();
}

/**
 * One request: read the body (capped), build the fetch Request, run the app, relay its answer.
 * A request that can't be read or built is answered 400; an app that throws, 500.
 */
async function serveOne(
  app: FetchApp,
  req: IncomingMessage,
  res: ServerResponse,
  o: { max: number; tooLarge: string; headers: boolean },
) {
  let request: Request;

  try {
    const body = await readCapped(req, res, o);

    if (!body) {
      return;
    }

    request = toRequest(req, res, { body, headers: o.headers });
  } catch {
    fail(res, 400);

    return;
  }

  try {
    await relay(await app(request), res);
  } catch {
    fail(res, 500);
  }
}

/** Serve `app` on Node's http module, with the given 413 text. */
function serveCapped(
  app: FetchApp,
  o: ServeFetchOptions,
  tooLarge: string,
): Promise<HttpServer> {
  const settings = {
    max: o.maxBody ?? MAX_FRAME,
    tooLarge,
    headers: o.headers ?? false,
  };
  const server = createHttpServer((req, res) => {
    req.on('error', () => {
      // an aborted upload surfaces through the body read
    });
    void serveOne(app, req, res, settings);
  });

  return new Promise((resolve) =>
    server.listen(o.port ?? 8080, o.host ?? '127.0.0.1', () => resolve(server)),
  );
}

/**
 * Serve a fetch handler on Node's http module. The request body is read before the app runs, up
 * to `maxBody`; a bigger one gets 413 and never reaches the app. Resolves once listening.
 */
export function serveFetch(
  app: FetchApp,
  o: ServeFetchOptions = {},
): Promise<HttpServer> {
  const max = o.maxBody ?? MAX_FRAME;

  if (!Number.isSafeInteger(max) || max < 0) {
    throw new RangeError(`maxBody must be a whole number of bytes, got ${max}`);
  }

  return serveCapped(app, o, `request body exceeds ${sizeText(max)}`);
}

/** Serve the HTTP bridge on Node's http module. */
export function serveHttp(
  svc: Service,
  o: { port?: number; host?: string; path?: string } = {},
): Promise<HttpServer> {
  return serveCapped(
    fetchHandler(svc, { path: o.path }),
    { port: o.port, host: o.host, maxBody: MAX_FRAME },
    'frame exceeds 1 MiB',
  );
}

function socketTransport(sock: net.Socket): Transport {
  const t = lines(
    (s) => sock.write(s),
    () => sock.end(),
  );

  sock.setEncoding('utf8');
  sock.on('data', (c: string) => t.feed(c));
  sock.on('error', (e) => t.fail(e));
  sock.on('close', () => t.fail(new Error('connection closed')));

  return t;
}

/** Open a transport from a URL: yea://, yeas://, http(s)://, or stdio:<command>. */
export async function transport(
  url: string,
  o: { tls?: tls.ConnectionOptions } = {},
): Promise<Transport> {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return http(url);
  }

  if (url.startsWith('stdio:')) {
    const [cmd, ...args] = url.slice(6).trim().split(/\s+/);
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    const t = lines(
      (s) => child.stdin.write(s),
      () => child.kill(),
    );

    child.on('error', (e) => t.fail(e));
    child.stdin.on('error', () => {
      // EPIPE after the child exits; the 'exit' handler already failed the transport
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => t.feed(c));
    child.on('exit', () => t.fail(new Error('service process exited')));

    return t;
  }

  const u = new URL(url);
  const secure = u.protocol === 'yeas:';

  if (!secure && u.protocol !== 'yea:') {
    throw new Error(`unsupported URL ${url}`);
  }

  const port = Number(u.port) || (secure ? DEFAULT_TLS_PORT : DEFAULT_PORT);
  const sock: net.Socket = await new Promise((resolve, reject) => {
    const s = secure
      ? tls.connect(
          { host: u.hostname, port, servername: u.hostname, ...o.tls },
          () => resolve(s),
        )
      : net.connect({ host: u.hostname, port }, () => resolve(s));

    s.once('error', reject);
  });

  return socketTransport(sock);
}

/** Connect a client to a YEA service by URL. */
export async function connect(
  url: string,
  opts: ClientOptions & { tls?: tls.ConnectionOptions } = {},
): Promise<Client> {
  return new Client(await transport(url, { tls: opts.tls }), opts);
}

export {
  checkKeyFile,
  defaultFileStore,
  FileStore,
  readPinnedKey,
} from './filestore.js';

export {
  agentKey,
  home,
  loadConsent,
  loadGrants,
  saveGrant,
} from './home.js';

export {
  canCheckOwners,
  checkServerKeyDir,
  type PrivateFileOptions,
  readPrivateFile,
  readServerSeed,
  SERVER_NAME,
  serverKeyPath,
  uid,
} from './keyfile.js';

export { listServices } from './setup.js';
