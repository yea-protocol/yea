/**
 * Stripe, as this connector calls it: the official SDK, pinned to one API version, with what the
 * connector adds on top. Each write gets a fresh idempotency key, each failure becomes a
 * `StripeError` that says what to do, and each answer is checked against the key's mode. Plus
 * the readers (customers, charges, subscriptions) that `examples/stripe-billing.ts` shares.
 */
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';

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

/** The SDK, with each call's answer or failure settled the connector's way. */
export interface StripeApi {
  /** A call that changes nothing: a GET, or `invoices.createPreview`. */
  read<T>(call: (s: Stripe) => Promise<T>): Promise<T>;
  /**
   * A write. `o` carries a fresh random idempotency key, which the call passes to the SDK, and
   * which only the SDK's own retries of that request reuse: a second call is a second write.
   */
  write<T>(
    call: (s: Stripe, o: { idempotencyKey: string }) => Promise<T>,
  ): Promise<T>;
}

/** Keys never appear in messages: Stripe masks them, and this makes sure. */
export const redactKeys = (s: string) =>
  s.replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g, '$1_$2_…');

/** A key is live unless it says it's a test key, so an unknown format fails toward caution. */
export const isLiveKey = (key: string) => !key.includes('_test_');

/** The id of a field Stripe may expand into an object. */
export const idOf = (r: string | { id: string }) =>
  typeof r === 'string' ? r : r.id;

interface Settling {
  write: boolean;
  /** Whether the key looks live. */
  live: boolean;
  /** Takes the key, and anything like one, out of a message. */
  clean(s: string): string;
}

const { errors } = Stripe;

/** No answer came back: a connection failure or timeout, or a failure outside Stripe's errors. */
function noAnswer(e: unknown, o: Settling): StripeError {
  const why = o.clean(e instanceof Error ? e.message : String(e));

  return new StripeError(
    o.write
      ? `no answer from Stripe (${why}), so the write may have happened; check the Stripe dashboard before trying again`
      : `no answer from Stripe (${why}); try again shortly`,
    { status: 0, unknown: o.write },
  );
}

/** Stripe's error, said so an agent knows what to do next. */
function failure(e: unknown, o: Settling): StripeError {
  if (
    !(e instanceof errors.StripeError) ||
    e instanceof errors.StripeConnectionError
  ) {
    return noAnswer(e, o);
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
    unknown
      ? `Stripe failed (${said}), and the write may have happened; check the Stripe dashboard before trying again`
      : `Stripe: ${said}`,
    { status, code, unknown },
  );
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

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
function checkMode(answer: unknown, o: Settling) {
  if (modesIn(answer).some((m) => m !== o.live)) {
    throw new StripeError(
      `Stripe answered in ${o.live ? 'test' : 'live'} mode, but the key looks like a ${o.live ? 'live' : 'test'} key; refusing to go on${o.write ? '. The write may have happened: check the Stripe dashboard' : ''}`,
      { status: 0, unknown: o.write },
    );
  }
}

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

/** The first item's billing period (since API version 2025-03-31, it's on the item). */
export function period(s: Stripe.Subscription): { start: number; end: number } {
  const item = s.items.data[0];

  if (!item) {
    throw new StripeError(`${s.id} has no items`, { status: 0 });
  }

  return { start: item.current_period_start, end: item.current_period_end };
}

/**
 * A customer read must say which mode it's in: one that doesn't can't be checked against the
 * key, so it fails closed. (Answers that do say are checked on every request.)
 */
function withMode(customers: Stripe.Customer[]): Stripe.Customer[] {
  for (const c of customers) {
    if (typeof c.livemode !== 'boolean') {
      throw new StripeError(
        "Stripe's customer came back without livemode, so its mode can't be checked; refusing to go on",
        { status: 0 },
      );
    }
  }

  return customers;
}

/** Whether Stripe said it has no such object. */
const missing = (e: unknown) => e instanceof StripeError && e.status === 404;

/** One customer by id; a deleted one counts as missing. */
async function retrieveCustomer(
  api: StripeApi,
  id: string,
): Promise<Stripe.Customer | null> {
  try {
    const c = await api.read((s) => s.customers.retrieve(id));

    return c.deleted ? null : (withMode([c])[0] ?? null);
  } catch (e) {
    if (missing(e)) {
      return null;
    }

    throw e;
  }
}

const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/**
 * Customers matching what a person said, at most `limit`: an id, an exact email (a list call,
 * which has no indexing delay), or else Stripe's search on name and email, which is eventually
 * consistent.
 */
export async function findCustomers(
  api: StripeApi,
  who: string,
  limit = 5,
): Promise<Stripe.Customer[]> {
  const text = who.trim();

  if (CUSTOMER_ID.test(text)) {
    const c = await retrieveCustomer(api, text);

    return c ? [c] : [];
  }

  if (EMAIL.test(text)) {
    const byEmail = await api.read((s) =>
      s.customers.list({ email: text, limit }),
    );

    return withMode(byEmail.data);
  }

  // Stripe wants double-quoted, backslash-escaped strings.
  const q = JSON.stringify(text);
  const found = await api.read((s) =>
    s.customers.search({ query: `name:${q} OR email:${q}`, limit }),
  );

  return withMode(found.data);
}

/** A customer's most recent charges, newest first. */
export async function recentCharges(
  api: StripeApi,
  customer: string,
  limit = 10,
): Promise<Stripe.Charge[]> {
  return (await api.read((s) => s.charges.list({ customer, limit }))).data;
}

/** Subscriptions still in force: active, trialing or past due. */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** The most subscriptions one customer's list reads. */
const MAX_SUBSCRIPTIONS = 100;

/**
 * A customer's subscriptions that are still in force, from the first page of Stripe's default
 * list, which leaves out cancelled ones so they can't hide a live one. `more` says the page
 * wasn't the whole list.
 */
export async function subscriptionPage(
  api: StripeApi,
  customer: string,
): Promise<{ subs: Stripe.Subscription[]; more: boolean }> {
  const all = await api.read((s) =>
    s.subscriptions.list({ customer, limit: MAX_SUBSCRIPTIONS }),
  );

  return {
    subs: all.data.filter((x) => LIVE_STATUSES.has(x.status)),
    more: all.has_more,
  };
}

/**
 * All of a customer's subscriptions in force, for a job that acts on one: a list that doesn't
 * fit in one page is refused rather than read in part.
 */
export async function currentSubscriptions(
  api: StripeApi,
  customer: string,
): Promise<Stripe.Subscription[]> {
  const page = await subscriptionPage(api, customer);

  if (page.more) {
    throw new StripeError(
      `${customer} has more than ${MAX_SUBSCRIPTIONS} subscriptions; pass the sub_ id of the one you mean`,
      { status: 0 },
    );
  }

  return page.subs;
}

/** One subscription by id, if it's this customer's and still in force. */
export async function currentSubscription(
  api: StripeApi,
  customer: string,
  id: string,
): Promise<Stripe.Subscription | null> {
  if (!/^sub_[A-Za-z0-9]+$/.test(id)) {
    return null;
  }

  try {
    const sub = await api.read((s) => s.subscriptions.retrieve(id));

    return idOf(sub.customer) === customer && LIVE_STATUSES.has(sub.status)
      ? sub
      : null;
  } catch (e) {
    if (missing(e)) {
      return null;
    }

    throw e;
  }
}
