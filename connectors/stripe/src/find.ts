/**
 * Who and which subscription a call means. The connector never guesses: several matches return
 * a clarification whose options carry the ids to call again with.
 */
import { type Clarification, clarify } from '@yea-protocol/sdk';
import {
  currentSubscription,
  currentSubscriptions,
  findCustomers,
  type Stripe,
} from './api.js';
import type { Ctx } from './context.js';
import { formatMoney } from './currency.js';
import { label, quoted, safeText, who } from './text.js';

/** At most this many matches are listed; this many means there may be more. */
export const MAX_MATCHES = 5;

export type Found<T> = { found: T } | { clarify: Clarification };

/** "3 customers match", or "5 or more customers match" when the list is full. */
const howMany = (n: number, noun: string) =>
  `${n >= MAX_MATCHES ? `${MAX_MATCHES} or more` : n} ${noun}`;

/** The one customer `input.customer` means, or a question listing the matches. */
export async function oneCustomer<I extends { customer: string }>(
  ctx: Ctx,
  input: I,
): Promise<Found<Stripe.Customer>> {
  const matches = await findCustomers(ctx.stripe, input.customer, MAX_MATCHES);
  const [first] = matches;

  if (!first) {
    throw new Error(
      `no customer matches ${quoted(input.customer)}; try their exact email or cus_ id`,
    );
  }

  if (matches.length === 1) {
    return { found: first };
  }

  return {
    clarify: clarify(
      `${howMany(matches.length, 'customers match')} ${quoted(input.customer)}. Which one?`,
      matches.map((c) => ({
        label: label(c),
        params: { ...input, customer: c.id },
      })),
    ),
  };
}

/** A price's name as people know it: its nickname, else lookup key, else id. */
export const priceName = (p: Stripe.Price) =>
  safeText(p.nickname ?? p.lookup_key ?? p.id);

/** `pro (49.00 USD/month)`. */
export function priceLabel(p: Stripe.Price): string {
  const every = p.recurring
    ? `/${p.recurring.interval_count > 1 ? `${p.recurring.interval_count} ` : ''}${p.recurring.interval}`
    : '';
  const amount =
    typeof p.unit_amount === 'number'
      ? ` (${formatMoney(p.unit_amount, p.currency)}${every})`
      : '';

  return `${priceName(p)}${amount}`;
}

/** A subscription as a list label: its id and what it's on. */
const subLabel = (s: Stripe.Subscription) =>
  `${s.id}: ${s.items.data.map((i) => priceLabel(i.price)).join(', ')} (${s.status})`;

/** The one subscription meant: `input.subscription`, the only one, or a question. */
export async function oneSubscription<I extends { subscription?: string }>(
  ctx: Ctx,
  c: Stripe.Customer,
  input: I,
): Promise<Found<Stripe.Subscription>> {
  if (input.subscription !== undefined) {
    const s = await currentSubscription(ctx.stripe, c.id, input.subscription);

    if (!s) {
      throw new Error(
        `${quoted(input.subscription)} isn't a current subscription of ${who(c)}`,
      );
    }

    return { found: s };
  }

  const subs = await currentSubscriptions(ctx.stripe, c.id);
  const [first] = subs;

  if (!first) {
    throw new Error(`${who(c)} has no active subscription`);
  }

  if (subs.length === 1) {
    return { found: first };
  }

  return {
    clarify: clarify(
      `${who(c)} has ${subs.length} subscriptions. Which one?`,
      subs.map((s) => ({
        label: subLabel(s),
        params: { ...input, customer: c.id, subscription: s.id },
      })),
    ),
  };
}

/** Refuse what v0 can't do safely: a subscription with more than one item. */
export function oneItem(s: Stripe.Subscription) {
  const [item, ...more] = s.items.data;

  if (!item || more.length) {
    throw new Error(
      `${s.id} has ${s.items.data.length} items; subscriptions with more than one item aren't supported yet, so change it in the Stripe dashboard`,
    );
  }

  return item;
}
