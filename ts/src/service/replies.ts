/**
 * Reading requests and building the reply frames the verb handlers share: a request's params,
 * ERROR from a thrown error, replays, EVENTs, and the holder key a reply is fitted for.
 */
import { randomId } from '../crypto.js';
import { YeaError } from '../errors.js';
import { replyFrame } from '../frames.js';
import type { ServiceOptions } from '../plan.js';
import type { ErrorReply, Event, FinalReply, Request } from '../types.js';

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
    // a failing onError must not fail the request (as in neverThrows)
  }

  return replyFrame(re, 'ERROR', {
    code: 'internal',
    message: 'the service failed unexpectedly',
    retry: 5,
  });
}

/** A request's params: `{}` when absent or null, and otherwise an object (SPEC §4.2, §4.3). */
export function paramsOf(req: { params?: unknown }): Record<string, unknown> {
  const params: unknown = req.params;

  if (params === undefined || params === null) {
    return {};
  }

  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new YeaError('invalid_params', '`params` must be an object');
  }

  return params as Record<string, unknown>;
}

/** The holder key of a request whose proof has already been verified by authorize() (grants present ⇒ proof checked). */
export const verifiedKey = (req: Request): string | null =>
  req.grants?.length && req.proof ? req.proof.key : null;

/**
 * A prior reply re-issued for a repeated request: a repeated COMMIT or UNDO, or an auto INTENT
 * (§4.3.1). It is a new frame, so it gets a fresh id (§2.1); a receipt is marked `replay`.
 */
export const replayOf = <R extends FinalReply>(prior: R, re: string): R => ({
  ...prior,
  id: randomId('s', 6),
  re,
  ...(prior.kind === 'RECEIPT' ? { replay: true } : {}),
});

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
