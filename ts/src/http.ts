/** HTTP bridge server side (SPEC §2.4) as a standard fetch handler: Workers, Bun, Deno, Node. */
import { errorLine, frameId } from './frames.js';
import type { Service } from './service.js';

const MAX_FRAME = 1 << 20;
const TOO_LARGE = Symbol('too large');

const tooLarge = () => new Response('frame exceeds 1 MiB', { status: 413 });

/** The POSTed JSON frame; null when unreadable or not JSON (the service answers that with an ERROR). */
async function readFrame(req: Request): Promise<unknown> {
  try {
    const text = await req.text();

    if (new TextEncoder().encode(text).length > MAX_FRAME) {
      return TOO_LARGE;
    }

    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Stream the service's events and final reply as NDJSON. */
function ndjsonReply(svc: Service, frame: unknown): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const re = frameId(frame);

      try {
        const final = await svc.handle(frame, (e) =>
          ctrl.enqueue(enc.encode(`${JSON.stringify(e)}\n`)),
        );

        ctrl.enqueue(enc.encode(`${JSON.stringify(final)}\n`));
      } catch {
        ctrl.enqueue(
          enc.encode(
            errorLine({
              id: 's_err',
              re,
              code: 'internal',
              message: 'reply could not be serialized',
            }),
          ),
        );
      }

      ctrl.close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
    },
  });
}

export function fetchHandler(svc: Service, o: { path?: string } = {}) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const endpoint = o.path ?? '/yea';

    if (
      req.method === 'GET' &&
      (url.pathname === '/.well-known/yea' || url.pathname === endpoint)
    ) {
      const budget = Number(url.searchParams.get('budget')) || undefined;

      return Response.json({ ...svc.brief(budget), endpoint });
    }

    if (req.method !== 'POST' || url.pathname !== endpoint) {
      return new Response('not a yea endpoint', { status: 404 });
    }

    if (Number(req.headers.get('content-length') ?? 0) > MAX_FRAME) {
      return tooLarge();
    }

    const frame = await readFrame(req);

    return frame === TOO_LARGE ? tooLarge() : ndjsonReply(svc, frame);
  };
}
