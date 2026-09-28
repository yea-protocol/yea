/**
 * Teaching errors (SPEC §7): `YeaError`, and the `fix` and `fail` helpers
 * handlers use to build them.
 */
import type { ConsentRequest, ErrorCode, Fix } from './types.js';

/** Throw from a handler to send a teaching ERROR reply (SPEC §7). */
export class YeaError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public extra: {
      fix?: Fix[];
      need?: unknown[];
      consent?: ConsentRequest;
      retry?: number | null;
    } = {},
  ) {
    super(message);
    this.name = 'YeaError';
  }
}

/** Build a fix: a sentence plus an optional params merge patch that should make the request succeed. */
export const fix = (say: string, params?: Record<string, unknown>): Fix =>
  params ? { say, params } : { say };

export const fail = (
  code: ErrorCode,
  message: string,
  extra?: YeaError['extra'],
): never => {
  throw new YeaError(code, message, extra);
};
