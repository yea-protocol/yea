/**
 * `refund`: all of a payment, what's unused of the subscription it paid for, or an amount.
 * Stripe can't reverse a refund, so no plan has an undo window, and a refund always asks.
 */
import { create, type JobPlan, update } from '@yea-protocol/sdk';
import { idOf, recentCharges, type Stripe, subscriptionPage } from '../api.js';
import {
  applying,
  type Ctx,
  day,
  type JobSpec,
  riskFor,
  tag,
} from '../context.js';
import { formatMoney, formatNumber, toQuantity } from '../currency.js';
import { inputSchema, oneCustomer } from '../find.js';
import { who } from '../text.js';
import { partialAmount, unusedPart } from './refund/amounts.js';
import { pastRefunds, pickCharge, refuseRefunded } from './refund/payment.js';

// --- input schema ---

interface RefundInput {
  customer: string;
  payment?: string;
  amount?: string;
}

const SCHEMA = inputSchema({
  payment: {
    type: 'string',
    description:
      'The ch_ or pi_ id of the payment. Default: their latest payment with something left to refund.',
  },
  amount: {
    type: 'string',
    description:
      'A partial refund, as a decimal string in the payment currency, like "12.50". Default: offer all of it, and what is unused.',
  },
});

// --- plan() ---

/** The payment being refunded, and the refunds already made on it. */
interface Paid {
  c: Stripe.Customer;
  ch: Stripe.Charge;
  earlier: Stripe.Refund[];
}

/**
 * Where a summary names the payment: its date, and what's already been refunded and when, so
 * a repeat after a refund whose result was unknown reads differently from a first refund.
 */
function paidLine(p: Paid): string {
  const { ch } = p;
  const last = p.earlier.find((r) => r.status === 'succeeded');

  if (ch.amount_refunded <= 0) {
    return `paid ${day(ch.created)}`;
  }

  return `paid ${day(ch.created)}; already refunded ${formatMoney(ch.amount_refunded, ch.currency)}${last ? ` on ${day(last.created)}` : ''}`;
}

/**
 * What a person types: the amount, and for a payment already partly refunded, the amount then
 * "again", so a repeat can't be approved by habit.
 */
const phraseFor = (p: Paid, amount: number) =>
  `${formatNumber(amount, p.ch.currency)}${p.ch.amount_refunded > 0 ? ' again' : ''}`;

/** One refund plan. Money leaves the business, so it reports `spend`. */
function refund(
  ctx: Ctx,
  p: Paid,
  o: { amount: number; why: string },
): JobPlan {
  const { c, ch } = p;
  const cur = ch.currency;
  const money = formatMoney(o.amount, cur);

  return {
    summary: `${tag(ctx)} Refund ${money} of ${ch.id} (${paidLine(p)}) to ${who(c)} (${o.why})`,
    effects: [
      create(
        'refund',
        `${money} back to the payment method of ${ch.id}; Stripe can't reverse it`,
      ),
      update(
        `charge/${ch.id}`,
        'amount_refunded',
        formatMoney(ch.amount_refunded, cur),
        formatMoney(ch.amount_refunded + o.amount, cur),
      ),
    ],
    uses: { spend: toQuantity(o.amount, cur) },
    risk: riskFor(ctx, 'medium'),
    data: { confirm: phraseFor(p, o.amount) },
    apply: () => applyRefund(ctx, ch, o.amount),
  };
}

/** The refund plans: the amount asked for, or all that's left and, when it applies, what's unused. */
async function plan(ctx: Ctx, input: RefundInput) {
  const found = await oneCustomer(ctx, input);

  if ('clarify' in found) {
    return found.clarify;
  }

  const c = found.found;
  const [chs, subs] = await Promise.all([
    recentCharges(ctx.stripe, c.id),
    subscriptionPage(ctx.stripe, c.id),
  ]);
  const ch = pickCharge(chs, c, input.payment);
  const p: Paid = { c, ch, earlier: await pastRefunds(ctx, ch) };
  const left = ch.amount - ch.amount_refunded;

  if (left <= 0) {
    refuseRefunded(c, ch, {
      earlier: p.earlier,
      chs,
      named: input.payment !== undefined,
    });
  }

  if (input.amount !== undefined) {
    const amount = partialAmount(input.amount, ch);

    return [refund(ctx, p, { amount, why: 'partial' })];
  }

  const plans = [
    refund(ctx, p, {
      amount: left,
      why: ch.amount_refunded > 0 ? "all of what's left" : 'all of it',
    }),
  ];
  const unused = unusedPart(ctx, ch, chs[0], subs.subs);

  if (unused) {
    plans.push(
      refund(ctx, p, {
        amount: unused.amount,
        why: `estimated unused ${unused.days} days of the current period`,
      }),
    );
  }

  return plans;
}

// --- apply() ---

/** Refund `amount` of the payment, through its payment intent when it has one. */
function applyRefund(ctx: Ctx, ch: Stripe.Charge, amount: number) {
  const target = ch.payment_intent
    ? { payment_intent: idOf(ch.payment_intent) }
    : { charge: ch.id };

  return applying(async () => {
    const r = await ctx.stripe.write((s, o) =>
      s.refunds.create({ ...target, amount }, o),
    );

    return {
      plan: 'refund',
      refund: r.id,
      status: r.status,
      charge: ch.id,
      amount: formatMoney(amount, ch.currency),
    };
  });
}

// --- revert() ---
// None: Stripe can't reverse a refund, so the job has no `revert`.

// --- the job ---

/** The `refund` job, before `server.ts` registers it. */
export function refundJob(ctx: Ctx): JobSpec<RefundInput> {
  return {
    name: 'refund',
    title: 'Refund a payment',
    description:
      "Refund a customer's payment, for the Stripe API: all of it, what's unused of their subscription, or an amount. Refunds can't be undone, so the user always approves by typing the amount.",
    schema: SCHEMA,
    risk: riskFor(ctx, 'medium'),
    plan: (input) => plan(ctx, input),
  };
}
