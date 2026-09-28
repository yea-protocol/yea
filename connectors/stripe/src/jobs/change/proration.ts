/**
 * What a change "now" charges or credits, from Stripe's preview of the prorated invoice: the
 * words for the summary, the effect, and the `spend` a credit reports.
 */
import { create } from '@yea-protocol/sdk';
import type { Stripe } from '../../api.js';
import { formatMoney, toQuantity } from '../../currency.js';

/**
 * What "now" is previewed as: `total` is the proration's net (positive is a charge, negative a
 * credit), and `amount_due` what's charged after the customer's credit balance.
 */
type Preview = Pick<Stripe.Invoice, 'total' | 'amount_due' | 'currency'>;

/** A prorated charge: what's due after the customer's balance, which is what's charged. */
function charge(p: Preview, from: string) {
  const net = formatMoney(p.total, p.currency);
  const due = formatMoney(p.amount_due, p.currency);
  const says =
    p.amount_due === p.total
      ? `Stripe charges ${due} today`
      : p.amount_due > 0
        ? `Stripe charges ${due} today (${net}, less their credit balance)`
        : `${net}, paid from their credit balance`;

  return {
    says: `${says} (prorated)`,
    effect: create(
      'invoice',
      `${net} prorated, ${due} charged today; if the payment fails, the subscription stays on ${from}`,
    ),
    uses: undefined,
  };
}

/** What "now" charges or credits, in words and as `spend` (only a credit leaves the business). */
export function proration(p: Preview, from: string) {
  if (p.total > 0) {
    return charge(p, from);
  }

  if (p.total < 0) {
    const money = formatMoney(-p.total, p.currency);

    return {
      says: `${money} goes to their Stripe credit balance (prorated)`,
      effect: create('credit', `${money} to the customer's balance`),
      uses: { spend: toQuantity(-p.total, p.currency) },
    };
  }

  return { says: 'no charge (prorated)', effect: null, uses: undefined };
}
