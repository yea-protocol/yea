/** The Transport a client talks through, the in-process one, and the line framing the stream transports share. */
import type { Service } from '../service.js';
import type { Event, FinalReply, Request } from '../types.js';

export const MAX_REPLY = 16 << 20;

export interface Transport {
  request(frame: Request, onEvent?: (e: Event) => void): Promise<FinalReply>;
  close(): void;
}

/** In-process transport: call a Service directly (tests, embedding, MCP bridge). */
export function local(svc: Service): Transport {
  return {
    request: (frame, onEvent) =>
      svc.handle(JSON.parse(JSON.stringify(frame)), onEvent),
    close() {
      // nothing to release: the service runs in this process
    },
  };
}

/** Split off the complete lines in `buf`: the trimmed non-empty ones, and the unterminated rest. */
export function completeLines(buf: string): {
  complete: string[];
  rest: string;
} {
  const end = buf.lastIndexOf('\n') + 1;

  return {
    complete: buf
      .slice(0, end)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    rest: buf.slice(end),
  };
}
