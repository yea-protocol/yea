/**
 * The readers the jobs and `examples/stripe-billing.ts` share: customers, charges and
 * subscriptions, with the ids and fields they're told apart by.
 */
import type { Stripe, StripeApi } from './client.js';
import { StripeError } from './errors.js';

/** A subscription id, which a job checks before it acts on one. */
export const SUB_ID = /^sub_[A-Za-z0-9]+$/;

/** A subscription schedule id, which `revert` checks in what `apply()` returned. */
export const SCHEDULE_ID = /^sub_sched_[A-Za-z0-9]+$|^sch_[A-Za-z0-9]+$/;

const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** Subscriptions still in force: active, trialing or past due. */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** The most subscriptions one customer's list reads. */
const MAX_SUBSCRIPTIONS = 100;

/** The id of a field Stripe may expand into an object. */
export const idOf = (r: string | { id: string }) =>
  typeof r === 'string' ? r : r.id;

/** The first item's billing period (since API version 2025-03-31, it's on the item). */
export function period(s: Stripe.Subscription): { start: number; end: number } {
  const item = s.items.data[0];

  if (!item) {
    throw new StripeError(`${s.id} has no items`, { status: 0 });
  }

  return { start: item.current_period_start, end: item.current_period_end };
}

/** Whether the subscription is set to end: at period end, or at a date. */
export const cancelling = (s: Stripe.Subscription) =>
  s.cancel_at_period_end || s.cancel_at !== null;

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

/** A failed read: null when Stripe said it has no such object, else thrown on. */
function nullIfMissing(e: unknown): null {
  if (e instanceof StripeError && e.status === 404) {
    return null;
  }

  throw e;
}

/** One customer by id; a deleted one counts as missing. */
async function retrieveCustomer(
  api: StripeApi,
  id: string,
): Promise<Stripe.Customer | null> {
  const c = await api
    .read((s) => s.customers.retrieve(id))
    .catch(nullIfMissing);

  return !c || c.deleted ? null : (withMode([c])[0] ?? null);
}

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
  if (!SUB_ID.test(id)) {
    return null;
  }

  const sub = await api
    .read((s) => s.subscriptions.retrieve(id))
    .catch(nullIfMissing);

  return sub && idOf(sub.customer) === customer && LIVE_STATUSES.has(sub.status)
    ? sub
    : null;
}
