/**
 * The Stripe client: the official SDK, pinned to one API version, with a fresh idempotency key
 * on each write and each answer or failure settled the connector's way.
 */
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { checkMode, failure, redactKeys } from './errors.js';

export type { Stripe };

/**
 * The version this connector is tested against, and the one stripe 22.6 pins. Typed as the
 * SDK's latest, so an SDK that moves to another version fails the build rather than changing
 * what's sent. Periods live on subscription items since basil.
 */
export const STRIPE_VERSION: Stripe.LatestApiVersion = '2026-08-26.dahlia';

export interface StripeOptions {
  /** A secret (`sk_…`) or restricted (`rk_…`) key. */
  key: string;
  /** For tests: the `fetch` the SDK sends requests with. Default: the SDK's Node client. */
  fetch?: typeof fetch;
}

/** The SDK, with each call's answer or failure settled the connector's way. */
export interface StripeApi {
  /** A call that changes nothing: a GET, or `invoices.createPreview`. */
  read<T>(call: (s: Stripe) => Promise<T>): Promise<T>;
  /**
   * A write. `o` carries a fresh random idempotency key, which the call passes to the SDK, and
   * which only the SDK's own retries of that request reuse: a second call is a second write.
   * Stripe ignores the key on a DELETE, so a DELETE also passes `maxNetworkRetries: 0`.
   */
  write<T>(
    call: (s: Stripe, o: { idempotencyKey: string }) => Promise<T>,
  ): Promise<T>;
}

/** A key is live unless it says it's a test key, so an unknown format fails toward caution. */
export const isLiveKey = (key: string) => !key.includes('_test_');

/**
 * Create the client. The key is only ever sent to Stripe, in the Authorization header. The SDK
 * retries network failures, conflicts and 5xx twice, with the same idempotency key. Telemetry
 * is off: with it on, the SDK keeps a machine id in ~/.config/stripe and sends it with the
 * platform on every request.
 */
export function stripeApi(o: StripeOptions): StripeApi {
  const stripe = new Stripe(o.key, {
    apiVersion: STRIPE_VERSION,
    maxNetworkRetries: 2,
    timeout: 30_000,
    telemetry: false,
    ...(o.fetch ? { httpClient: Stripe.createFetchHttpClient(o.fetch) } : {}),
  });
  const live = isLiveKey(o.key);
  const clean = (text: string) => redactKeys(text).split(o.key).join('…');
  const settle = async <T>(call: () => Promise<T>, write: boolean) => {
    const how = { write, live, clean };
    let answer: T;

    try {
      answer = await call();
    } catch (e) {
      throw failure(e, how);
    }

    checkMode(answer, how);

    return answer;
  };

  return {
    read: (call) => settle(() => call(stripe), false),
    write: (call) =>
      settle(() => call(stripe, { idempotencyKey: randomUUID() }), true),
  };
}
