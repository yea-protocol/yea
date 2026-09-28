/** Node transports: TCP (yea://), TLS (yeas://), stdio, and an HTTP bridge server. */
import { spawn } from 'node:child_process';
import type { Server as HttpServer } from 'node:http';
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
import { serveCapped } from './serve-fetch.js';
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
} from './file-store.js';

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

export {
  type FetchApp,
  type FetchGate,
  MAX_REQUEST_BODY,
  type ServeFetchOptions,
  serveFetch,
} from './serve-fetch.js';

export { listServices } from './setup.js';
