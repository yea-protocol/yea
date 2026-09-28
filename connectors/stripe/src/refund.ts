/**
 * `refund`: all of a payment, what's unused of the subscription it paid for, or an amount.
 * Stripe can't reverse a refund, so no plan has an undo window, and a refund always asks.
 */
import { create, type JobPlan, update } from '@yea-protocol/sdk';
import {
  type Charge,
  type Customer,
  period,
  recentCharges,
  type Subscription,
  subscriptionPage,
} from './api.js';
import {
  applying,
  type Ctx,
  DAY,
  day,
  type JobSpec,
  riskFor,
  startOfDay,
  tag,
} from './context.js';
import {
  formatMoney,
  formatNumber,
  parseMoney,
  roundDown,
  toQuantity,
} from './currency.js';
import { oneCustomer } from './find.js';
import { quoted, who } from './text.js';

export interface RefundInput {
  customer: string;
  payment?: string;
  amount?: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    customer: {
      type: 'string',
      description: "The customer's name, email or cus_ id.",
    },
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
  },
  required: ['customer'],
  additionalProperties: false,
};

const paymentLine = (x: Charge) =>
  `${x.id} (${day(x.created)}, ${formatMoney(x.amount, x.currency)}, ${formatMoney(x.amount - x.amount_refunded, x.currency)} left, ${x.status})`;

/**
 * The payment asked for, or else the latest one that succeeded. Never an older one when the
 * latest is fully refunded: a retry after a refund whose result was unknown would then refund a
 * different payment of the same amount, under the same phrase.
 */
function pickCharge(chs: Charge[], c: Customer, payment?: string): Charge {
  const ch = payment
    ? chs.find((x) => x.id === payment || x.payment_intent === payment)
    : chs.find((x) => x.status === 'succeeded');

  if (ch && ch.status === 'succeeded') {
    return ch;
  }

  const listed = chs.slice(0, 5).map(paymentLine).join('; ');
  const what = payment
    ? `${quoted(payment)} isn't one of ${who(c)}'s recent payments that succeeded`
    : `${who(c)} has no recent payment that succeeded`;

  throw new Error(`${what}${listed ? `. Recent payments: ${listed}` : ''}`);
}

interface PastRefund {
  id: string;
  amount: number;
  created: number;
  status: string;
}

/** The refunds already made on a charge, newest first; none when nothing was refunded. */
async function pastRefunds(ctx: Ctx, ch: Charge): Promise<PastRefund[]> {
  if (ch.amount_refunded <= 0) {
    return [];
  }

  return (
    await ctx.stripe.get<{ data: PastRefund[] }>('/refunds', {
      charge: ch.id,
      limit: '10',
    })
  ).data;
}

const refundLine = (r: PastRefund, cur: string) =>
  `${r.id} (${formatMoney(r.amount, cur)}, ${day(r.created)}, ${r.status})`;

/** A payment with nothing left is refused, naming the refunds already made. */
function refuseRefunded(
  c: Customer,
  ch: Charge,
  o: { earlier: PastRefund[]; chs: Charge[]; named: boolean },
): never {
  const refunds = o.earlier.map((r) => refundLine(r, ch.currency)).join('; ');
  const older = o.named
    ? ''
    : `; to refund an older payment, pass its id as payment. Recent payments: ${o.chs.slice(0, 5).map(paymentLine).join('; ')}`;

  throw new Error(
    `${who(c)}'s payment ${ch.id} (${day(ch.created)}) is fully refunded${refunds ? `, by ${refunds}` : ''}${older}`,
  );
}

/** A partial refund: a valid amount in this currency, no more than what's left. */
function partialAmount(text: string, ch: Charge): number {
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
function unusedPart(
  ctx: Ctx,
  ch: Charge,
  latest: Charge | undefined,
  subs: Subscription[],
) {
  const sub = subs.find((s) => {
    const p = s.items.data.length === 1 ? period(s) : null;

    return p !== null && ch.created >= p.start && ch.created < p.end;
  });

  if (!sub || latest?.id !== ch.id) {
    return null;
  }

  const { start, end } = period(sub);
  const from = Math.max(startOfDay(ctx.now()), start);
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

/** The payment being refunded, and the refunds already made on it. */
interface Paid {
  c: Customer;
  ch: Charge;
  earlier: PastRefund[];
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
function refundPlan(
  ctx: Ctx,
  p: Paid,
  refund: { amount: number; why: string },
): JobPlan {
  const { c, ch } = p;
  const cur = ch.currency;
  const money = formatMoney(refund.amount, cur);
  const target = ch.payment_intent
    ? { payment_intent: ch.payment_intent }
    : { charge: ch.id };

  return {
    summary: `${tag(ctx)} Refund ${money} of ${ch.id} (${paidLine(p)}) to ${who(c)} (${refund.why})`,
    effects: [
      create(
        'refund',
        `${money} back to the payment method of ${ch.id}; Stripe can't reverse it`,
      ),
      update(
        `charge/${ch.id}`,
        'amount_refunded',
        formatMoney(ch.amount_refunded, cur),
        formatMoney(ch.amount_refunded + refund.amount, cur),
      ),
    ],
    uses: { spend: toQuantity(refund.amount, cur) },
    risk: riskFor(ctx, 'medium'),
    data: { confirm: phraseFor(p, refund.amount) },
    apply: () =>
      applying(async () => {
        const r = await ctx.stripe.write<{ id: string; status: string }>(
          'POST',
          '/refunds',
          { ...target, amount: refund.amount },
        );

        return {
          plan: 'refund',
          refund: r.id,
          status: r.status,
          charge: ch.id,
          amount: money,
        };
      }),
  };
}

/** The refund plans: the amount asked for, or all that's left and, when it applies, what's unused. */
async function refundPlans(ctx: Ctx, input: RefundInput) {
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

    return [refundPlan(ctx, p, { amount, why: 'partial' })];
  }

  const plans = [
    refundPlan(ctx, p, {
      amount: left,
      why: ch.amount_refunded > 0 ? "all of what's left" : 'all of it',
    }),
  ];
  const unused = unusedPart(ctx, ch, chs[0], subs.subs);

  if (unused) {
    plans.push(
      refundPlan(ctx, p, {
        amount: unused.amount,
        why: `estimated unused ${unused.days} days of the current period`,
      }),
    );
  }

  return plans;
}

export function refundJob(ctx: Ctx): JobSpec<RefundInput> {
  return {
    name: 'refund',
    title: 'Refund a payment',
    description:
      "Refund a customer's payment, for the Stripe API: all of it, what's unused of their subscription, or an amount. Refunds can't be undone, so the user always approves by typing the amount.",
    schema: SCHEMA,
    risk: riskFor(ctx, 'medium'),
    plan: (input) => refundPlans(ctx, input),
  };
}
