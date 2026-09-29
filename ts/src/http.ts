/** HTTP bridge server side (SPEC §2.4) as a standard fetch handler: Workers, Bun, Deno, Node. */
import { errorLine, frameId } from './frames.js';
import type { Service } from './service.js';
import { positiveInt } from './util.js';

const MAX_FRAME = 1 << 20;
const TOO_LARGE = Symbol('too large');
/** Plain decimal notation (`800`, `800.0`, `1e3`): no hex, binary, `Infinity` or non-ASCII digits. */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

const tooLarge = () => new Response('frame exceeds 1 MiB', { status: 413 });

/**
 * `?budget=` read by the same rule as a frame's `budget`: a whole number above 0 in decimal
 * notation (`800.0` and `1e3` count). Anything else is undefined, so the default applies.
 */
export const queryBudget = (text: string | null): number | undefined =>
  text !== null && DECIMAL.test(text) ? positiveInt(Number(text)) : undefined;

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

/**
 * Stream the service's events and final reply as NDJSON. If the client goes away (the stream is
 * cancelled), the request still runs to the end: its lines are just no longer sent.
 */
function ndjsonReply(svc: Service, frame: unknown): Response {
  const enc = new TextEncoder();
  let open = true;
  const stream = new ReadableStream({
    async start(ctrl) {
      const re = frameId(frame);
      const send = (line: string) => {
        if (open) {
          ctrl.enqueue(enc.encode(line));
        }
      };

      try {
        const final = await svc.handle(frame, (e) =>
          send(`${JSON.stringify(e)}\n`),
        );

        send(`${JSON.stringify(final)}\n`);
      } catch {
        send(
          errorLine({
            id: 's_err',
            re,
            code: 'internal',
            message: 'reply could not be serialized',
          }),
        );
      }

      if (open) {
        ctrl.close();
      }
    },
    cancel() {
      open = false;
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
      const budget = queryBudget(url.searchParams.get('budget'));

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
