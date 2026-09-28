/** The line-framed stream transport: one JSON frame per line over any duplex, replies routed by `re`. */
import type { Event, FinalReply, Reply } from '../types.js';
import { completeLines, MAX_REPLY, type Transport } from './transport.js';

/** Line-framed stream transport over any duplex (TCP, TLS, child stdio). */
export function lines(
  write: (line: string) => void,
  close: () => void,
): Transport & { feed(chunk: string): void; fail(err: Error): void } {
  const pending = new Map<
    string,
    {
      resolve: (r: FinalReply) => void;
      reject: (e: Error) => void;
      onEvent?: (e: Event) => void;
    }
  >();
  let buf = '';
  /** Route one reply line to the request it answers; unparseable or unmatched lines are dropped. */
  const deliver = (line: string) => {
    let f: Reply;

    try {
      f = JSON.parse(line);
    } catch {
      return;
    }

    const p = pending.get(f.re);

    if (!p) {
      return;
    }

    if (f.kind === 'EVENT') {
      p.onEvent?.(f);
    } else {
      pending.delete(f.re);
      p.resolve(f);
    }
  };

  return {
    request(frame, onEvent) {
      return new Promise((resolve, reject) => {
        pending.set(frame.id, { resolve, reject, onEvent });
        write(`${JSON.stringify(frame)}\n`);
      });
    },
    feed(chunk) {
      buf += chunk;

      if (buf.length > MAX_REPLY && buf.indexOf('\n') < 0) {
        buf = '';
        this.fail(new Error('reply exceeds 16 MiB without a newline'));
        close();

        return;
      }

      const { complete, rest } = completeLines(buf);

      buf = rest;

      for (const line of complete) {
        deliver(line);
      }
    },
    fail(err) {
      for (const p of pending.values()) {
        p.reject(err);
      }

      pending.clear();
    },
    close,
  };
}
