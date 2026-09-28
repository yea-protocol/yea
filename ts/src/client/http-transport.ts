/** The HTTP bridge transport (SPEC §2.4): POST a frame, read the NDJSON reply stream to its final reply. */
import type { Event, FinalReply, Reply } from '../types.js';
import { completeLines, MAX_REPLY, type Transport } from './transport.js';

/** Pass EVENT lines to `onEvent` until the final reply, which is returned (undefined if none yet). */
function firstFinal(
  lines: string[],
  onEvent?: (e: Event) => void,
): FinalReply | undefined {
  for (const line of lines) {
    const f = JSON.parse(line) as Reply;

    if (f.kind === 'EVENT') {
      onEvent?.(f);
    } else {
      return f;
    }
  }

  return undefined;
}

/** Read an NDJSON reply stream up to its final reply. */
async function readFinal(
  body: NonNullable<Response['body']>,
  onEvent?: (e: Event) => void,
): Promise<FinalReply> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';

  for (;;) {
    const { value, done } = await reader.read();

    if (value) {
      buf += value;
    }

    if (buf.length > MAX_REPLY) {
      throw new Error('reply exceeds 16 MiB without a newline');
    }

    const { complete, rest } = completeLines(buf);

    buf = rest;

    const final = firstFinal(complete, onEvent);

    if (final) {
      return final;
    }

    if (done) {
      break;
    }
  }

  if (buf.trim()) {
    return JSON.parse(buf);
  }

  throw new Error('HTTP bridge closed without a final reply');
}

/** HTTP bridge transport (SPEC §2.4). Works anywhere `fetch` exists. */
export function http(
  endpoint: string,
  init: { headers?: Record<string, string> } = {},
): Transport {
  return {
    async request(frame, onEvent) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...init.headers },
        body: JSON.stringify(frame),
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} from ${endpoint}`);
      }

      return readFinal(res.body, onEvent);
    },
    close() {
      // each request is its own fetch; there is no connection to close
    },
  };
}
