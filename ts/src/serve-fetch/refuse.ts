/**
 * Refusing a request without running the app: answer framed by Content-Length with
 * `connection: close`, then read and discard a bounded amount of the body, then hang up.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** How much more of a refused request's body is read, and thrown away, before hanging up. */
const DRAIN = 1 << 20;

/** How long a refused client that's still sending has to read the answer before it's cut off. */
const GRACE = 1000;

export const textResponse = (status: number, body: string) =>
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
export async function refuse(
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
