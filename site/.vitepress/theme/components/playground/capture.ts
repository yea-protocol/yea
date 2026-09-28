/**
 * The playground's transport: it hands each request to an in-page service, like the SDK's
 * `local()`, and records the frame, the EVENTs, the final reply and the time it took.
 */
import type {
  Event,
  FinalReply,
  Request,
  Service,
  Transport,
} from '@yea-protocol/sdk';

/** What one request produced. */
export interface Captured {
  request: Request;
  reply: FinalReply;
  events: Event[];
  ms: number;
}

/** A transport to `service` that passes every exchange to `record` before returning the reply. */
export function captureTransport(
  service: Pick<Service, 'handle'>,
  record: (x: Captured) => void,
): Transport {
  return {
    async request(frame, onEvent) {
      const events: Event[] = [];
      const t0 = performance.now();
      // A JSON round trip, as a real transport would send it: the service can't share objects with the client.
      const copy: Request = JSON.parse(JSON.stringify(frame));
      const reply = await service.handle(copy, (e) => {
        events.push(e);
        onEvent?.(e);
      });

      record({ request: frame, reply, events, ms: performance.now() - t0 });

      return reply;
    },
    close() {
      // nothing to release: the service runs in this page
    },
  };
}
