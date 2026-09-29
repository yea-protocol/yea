/** Reply frames the verb handlers share: ERROR from a thrown error, replays, EVENTs, and the holder key a reply is fitted for. */
import { randomId } from '../crypto.js';
import { YeaError } from '../errors.js';
import { replyFrame } from '../frames.js';
import type { ServiceOptions } from '../plan.js';
import type { ErrorReply, Event, ReceiptReply, Request } from '../types.js';

/** The ERROR reply for `e`; anything but a YeaError is reported to `onError` and answered as `internal`. */
export function errorReply(
  opts: ServiceOptions,
  re: string,
  e: unknown,
): ErrorReply {
  if (e instanceof YeaError) {
    return replyFrame(re, 'ERROR', {
      code: e.code,
      message: e.message,
      ...e.extra,
    });
  }

  try {
    opts.onError?.(e);
  } catch {
    // a failing onError must not fail the request, nor leave a commit half-released
  }

  return replyFrame(re, 'ERROR', {
    code: 'internal',
    message: 'the service failed unexpectedly',
    retry: 5,
  });
}

/** The holder key of a request whose proof has already been verified by authorize() (grants present ⇒ proof checked). */
export const verifiedKey = (req: Request): string | null =>
  req.grants?.length && req.proof ? req.proof.key : null;

/** A prior commit/undo outcome re-issued for a repeated request. */
export const replayOf = (
  prior: ReceiptReply | ErrorReply,
  re: string,
): ReceiptReply | ErrorReply =>
  prior.kind === 'RECEIPT'
    ? { ...prior, id: randomId('s', 6), re, replay: true }
    : { ...prior, id: randomId('s', 6), re };

export const eventFrame = (
  re: string,
  message: string,
  progress?: number,
  data?: unknown,
): Event =>
  replyFrame(re, 'EVENT', {
    message,
    ...(progress !== undefined ? { progress } : {}),
    ...(data !== undefined ? { data } : {}),
  });
