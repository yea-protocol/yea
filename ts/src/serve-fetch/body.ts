/** Reading a request body under a byte cap: refused by its declared length, or as soon as it's over. */
import type { IncomingMessage } from 'node:http';

/** The request declares a body over `max` bytes (Content-Length). */
export const declaredOver = (req: IncomingMessage, max: number) =>
  Number(req.headers['content-length'] ?? 0) > max;

/**
 * Collect a request body, at most `max` bytes of it: null once it's over, by its declared
 * Content-Length before reading anything, else as soon as the bytes arrive. Nothing past `max`
 * is kept. Rejects if the request fails or closes before its end.
 */
export function readCapped(
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
