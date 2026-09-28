/** Between Node's http messages and fetch's: the Request the gate and the app see, and relaying the Response. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

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
export function headOf(req: IncomingMessage): Request {
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
export function toRequest(
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
export async function relay(r: Response, res: ServerResponse) {
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
export function fail(res: ServerResponse, status: number) {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-length': '0' });
  }

  res.end();
}
