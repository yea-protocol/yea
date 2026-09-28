/**
 * How much a refund can be: an amount asked for, checked against what's left of the payment,
 * or an estimate of what's unused of the subscription period it paid for.
 */
import { period, type Stripe } from '../../api.js';
import { type Ctx, DAY, today } from '../../context.js';
import { formatMoney, parseMoney, roundDown } from '../../currency.js';

/** A partial refund: a valid amount in this currency, no more than what's left. */
export function partialAmount(text: string, ch: Stripe.Charge): number {
  const left = ch.amount - ch.amount_refunded;
  const amount = parseMoney(text, ch.currency);

  if (amount <= 0 || amount > left) {
    throw new Error(
      `amount must be more than 0 and at most ${formatMoney(left, ch.currency)}, what's left of ${ch.id}`,
    );
  }

  return amount;
}

/**
 * An estimate of what's unused of the period this payment paid for, measured from the start of
 * today (UTC), so it's the same all day. Only for the latest payment, made in the current
 * period of a one-item subscription. It's an estimate: the charge isn't checked against the
 * subscription's invoice, and the plan says so.
 */
export function unusedPart(
  ctx: Ctx,
  ch: Stripe.Charge,
  latest: Stripe.Charge | undefined,
  subs: Stripe.Subscription[],
) {
  const sub = subs.find((s) => {
    const p = s.items.data.length === 1 ? period(s) : null;

    return p !== null && ch.created >= p.start && ch.created < p.end;
  });

  if (!sub || latest?.id !== ch.id) {
    return null;
  }

  const { start, end } = period(sub);
  const from = Math.max(today(ctx), start);
  const left = ch.amount - ch.amount_refunded;

  if (from >= end || end <= start) {
    return null;
  }

  // The unused share of what was PAID, less what's already been refunded, so asking again
  // after a refund never offers more. BigInt keeps it exact and the same on every machine.
  const share = (BigInt(ch.amount) * BigInt(end - from)) / BigInt(end - start);
  const amount = roundDown(Number(share) - ch.amount_refunded, ch.currency);

  if (amount <= 0 || amount >= left) {
    return null;
  }

  return { amount, days: Math.ceil((end - from) / DAY) };
}
