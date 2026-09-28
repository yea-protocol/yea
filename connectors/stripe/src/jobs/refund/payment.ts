/**
 * Which payment a refund is for: the one asked for or the latest that succeeded, the refunds
 * already made on it, and the refusal when nothing is left of it.
 */
import { idOf, type Stripe } from '../../api.js';
import { type Ctx, day } from '../../context.js';
import { formatMoney } from '../../currency.js';
import { quoted, who } from '../../text.js';

const paymentLine = (x: Stripe.Charge) =>
  `${x.id} (${day(x.created)}, ${formatMoney(x.amount, x.currency)}, ${formatMoney(x.amount - x.amount_refunded, x.currency)} left, ${x.status})`;

/** The latest few payments, for a refusal to list. */
const recentLines = (chs: Stripe.Charge[]) =>
  chs.slice(0, 5).map(paymentLine).join('; ');

const refundLine = (r: Stripe.Refund, cur: string) =>
  `${r.id} (${formatMoney(r.amount, cur)}, ${day(r.created)}, ${r.status})`;

/**
 * The payment asked for, or else the latest one that succeeded. Never an older one when the
 * latest is fully refunded: a retry after a refund whose result was unknown would then refund a
 * different payment of the same amount, under the same phrase.
 */
export function pickCharge(
  chs: Stripe.Charge[],
  c: Stripe.Customer,
  payment?: string,
): Stripe.Charge {
  const ch = payment
    ? chs.find(
        (x) =>
          x.id === payment ||
          (x.payment_intent !== null && idOf(x.payment_intent) === payment),
      )
    : chs.find((x) => x.status === 'succeeded');

  if (ch && ch.status === 'succeeded') {
    return ch;
  }

  const what = payment
    ? `${quoted(payment)} isn't one of ${who(c)}'s recent payments that succeeded`
    : `${who(c)} has no recent payment that succeeded`;

  throw new Error(
    `${what}${chs.length ? `. Recent payments: ${recentLines(chs)}` : ''}`,
  );
}

/** The refunds already made on a charge, newest first; none when nothing was refunded. */
export async function pastRefunds(
  ctx: Ctx,
  ch: Stripe.Charge,
): Promise<Stripe.Refund[]> {
  if (ch.amount_refunded <= 0) {
    return [];
  }

  return (
    await ctx.stripe.read((s) => s.refunds.list({ charge: ch.id, limit: 10 }))
  ).data;
}

/** A payment with nothing left is refused, naming the refunds already made. */
export function refuseRefunded(
  c: Stripe.Customer,
  ch: Stripe.Charge,
  o: { earlier: Stripe.Refund[]; chs: Stripe.Charge[]; named: boolean },
): never {
  const refunds = o.earlier.map((r) => refundLine(r, ch.currency)).join('; ');
  const older = o.named
    ? ''
    : `; to refund an older payment, pass its id as payment. Recent payments: ${recentLines(o.chs)}`;

  throw new Error(
    `${who(c)}'s payment ${ch.id} (${day(ch.created)}) is fully refunded${refunds ? `, by ${refunds}` : ''}${older}`,
  );
}
