/**
 * How a Stripe call fails, in words an agent can act on: `StripeError`, the SDK's failures
 * mapped onto it, and the mode check that refuses an answer from the other mode.
 */
import Stripe from 'stripe';

/** Why a Stripe request failed, in words an agent can act on. */
export class StripeError extends Error {
  /** The HTTP status; 0 when no response came back. */
  readonly status: number;
  /** Stripe's error `code`, when it gave one. */
  readonly code: string | undefined;
  /** A write whose result is unknown: it may have happened. */
  readonly unknown: boolean;
  /** The key lacks a permission this request needs. */
  readonly permission: boolean;

  constructor(
    message: string,
    o: { status: number; code?: string | undefined; unknown?: boolean },
  ) {
    super(message);
    this.name = 'StripeError';
    this.status = o.status;
    this.code = o.code;
    this.unknown = o.unknown ?? false;
    this.permission = o.status === 403;
  }
}

/** How a call's answer or failure is settled: a read or a write, under which key. */
export interface Settling {
  write: boolean;
  /** Whether the key looks live. */
  live: boolean;
  /** Takes the key, and anything like one, out of a message. */
  clean(s: string): string;
}

/** Keys never appear in messages: Stripe masks them, and this makes sure. */
export const redactKeys = (s: string) =>
  s.replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g, '$1_$2_…');

/** What was thrown, as text: an Error's message, or anything else as a string. */
export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

const { errors } = Stripe;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What `write` adds when the result is unknown. */
const MAY_HAVE_HAPPENED =
  ', so the write may have happened; check the Stripe dashboard before trying again';

/** The network's own reason for a connection failure, such as `ECONNRESET`. */
function causeOf(detail: unknown): string {
  if (typeof detail === 'string') {
    return detail;
  }

  const d = isObject(detail) ? detail : {};

  if (typeof d.code === 'string') {
    return d.code;
  }

  return typeof d.message === 'string' ? d.message : '';
}

/** No answer came back: the connection failed or timed out, after the SDK's retries. */
function noAnswer(
  e: InstanceType<typeof errors.StripeConnectionError>,
  o: Settling,
): StripeError {
  const cause = causeOf(e.detail);
  const why = o.clean(cause ? `${e.message} Cause: ${cause}` : e.message);

  return new StripeError(
    `no answer from Stripe (${why})${o.write ? MAY_HAVE_HAPPENED : '; try again shortly'}`,
    { status: 0, unknown: o.write },
  );
}

/** Stripe's error, said so an agent knows what to do next. */
export function failure(e: unknown, o: Settling): StripeError {
  if (e instanceof errors.StripeConnectionError) {
    return noAnswer(e, o);
  }

  // Not one of Stripe's answers: on a write, it may still have been sent.
  if (!(e instanceof errors.StripeError)) {
    const why = o.clean(errorMessage(e));

    return new StripeError(
      `the Stripe call failed (${why})${o.write ? MAY_HAVE_HAPPENED : ''}`,
      { status: 0, unknown: o.write },
    );
  }

  const status = e.statusCode ?? 0;
  const said = o.clean(e.message || `Stripe returned HTTP ${status}`);
  const code = e.code;

  if (e instanceof errors.StripePermissionError) {
    return new StripeError(
      `the Stripe key lacks a permission this needs (Stripe says: ${said}). Add that permission to the restricted key, then try again`,
      { status: 403, code },
    );
  }

  if (e instanceof errors.StripeAuthenticationError) {
    return new StripeError(
      `Stripe rejected the key (${said}); check STRIPE_SECRET_KEY_FILE`,
      { status, code },
    );
  }

  if (e instanceof errors.StripeRateLimitError) {
    return new StripeError('Stripe is rate limiting; try again shortly', {
      status,
      code,
    });
  }

  // A 5xx, a conflict or an unreadable answer: a write may have been applied before it failed.
  const unknown = o.write && e instanceof errors.StripeAPIError;

  return new StripeError(
    unknown ? `Stripe failed (${said})${MAY_HAVE_HAPPENED}` : `Stripe: ${said}`,
    { status, code, unknown },
  );
}

/** Every object in an answer that says which mode it's in. */
function modesIn(answer: unknown): boolean[] {
  if (!isObject(answer)) {
    return [];
  }

  const items = Array.isArray(answer.data) ? answer.data : [answer];

  return items.flatMap((x) =>
    isObject(x) && typeof x.livemode === 'boolean' ? [x.livemode] : [],
  );
}

/**
 * An answer from the other mode than the key looks like fails closed: the `[test]` or `[LIVE]`
 * a person approved would be wrong.
 */
export function checkMode(answer: unknown, o: Settling) {
  if (modesIn(answer).some((m) => m !== o.live)) {
    throw new StripeError(
      `Stripe answered in ${o.live ? 'test' : 'live'} mode, but the key looks like a ${o.live ? 'live' : 'test'} key; refusing to go on${o.write ? '. The write may have happened: check the Stripe dashboard' : ''}`,
      { status: 0, unknown: o.write },
    );
  }
}
