/**
 * What the billing example's intents propose: refunds (never undoable), plan changes and
 * cancellations, each a Plan with its effects, what it spends, and how to apply and revert it.
 */
import {
  create,
  fail,
  fix,
  type Plan,
  quantity,
  send,
  update,
  YeaError,
} from '../../index.js';
import {
  type Customer,
  DAY,
  date,
  type Payment,
  type PlanId,
  PRICES,
  usd,
} from './data.js';

const periodLeft = (c: Customer, now: number) =>
  Math.max(0, (c.renews - now) / (30 * DAY));

export function refundPlans(
  c: Customer,
  params: { payment?: string; usd?: number },
  now: number,
): Plan | Plan[] {
  const paid = c.payments.filter((p) => p.status === 'paid');
  const pay = params.payment
    ? c.payments.find((p) => p.id === params.payment)
    : paid.at(-1);

  if (!pay) {
    return fail(
      'not_found',
      `no payment ${JSON.stringify(params.payment)} for ${c.name}`,
      {
        fix: paid.map((p) =>
          fix(`use ${p.id} (${date(p.at)}, ${usd(p.amount)})`, {
            payment: p.id,
          }),
        ),
      },
    );
  }

  const left = pay.amount - pay.refunded;

  if (pay.status !== 'paid' || left <= 0) {
    return fail('conflict', `${pay.id} has nothing left to refund`);
  }

  const refund = refunder(c, pay);

  if (params.usd != null) {
    return refund(partial(params.usd, left), 'partial');
  }

  // Alternatives CRUD can't express: the whole payment, or only the unused part of this period.
  const unused = Math.round(left * periodLeft(c, now));
  const current = pay === paid.at(-1) && unused > 0 && unused < left;

  return current
    ? [
        refund(left, 'full'),
        refund(unused, `unused ${Math.round(periodLeft(c, now) * 30)} days`),
      ]
    : refund(left, 'full');
}

// A partial refund in dollars, in cents once checked against what's left.
function partial(dollars: number, left: number) {
  const amount = Math.round(dollars * 100);

  if (amount > 0 && amount <= left) {
    return amount;
  }

  throw new YeaError(
    'invalid_params',
    `refund must be between 0.01 and ${usd(left)}`,
    { fix: [fix(`refund the rest (${usd(left)})`, { usd: left / 100 })] },
  );
}

function refunder(c: Customer, pay: Payment) {
  return (amount: number, why: string): Plan => ({
    summary: `Refund ${usd(amount)} of ${pay.id} to ${c.name} (${why})`,
    effects: [
      update(
        `payment/${pay.id}`,
        'refunded',
        usd(pay.refunded),
        usd(pay.refunded + amount),
      ),
      send(
        c.email,
        `refund receipt, ${usd(amount)} back to ${c.card} in 5–10 days`,
      ),
    ],
    uses: spent(amount),
    apply: () => {
      pay.refunded += amount;

      return { refunded: usd(amount), payment: pay.id };
    },
    // No revert: money that has left can't be pulled back, so the proposal says undo: none.
  });
}

/** Cents charged or refunded, reported under the `spend` convention (docs/conventions.md). */
const spent = (cents: number) => ({
  spend: quantity(cents, { scale: 2, unit: 'USD' }),
});

export function changePlans(c: Customer, to: PlanId, now: number): Plan[] {
  const from = c.plan;

  if (to === from) {
    return fail('conflict', `${c.name} is already on ${to}`, {
      fix: (Object.keys(PRICES) as PlanId[])
        .filter((p) => p !== to)
        .map((p) => fix(`move to ${p}`, { plan: p })),
    });
  }

  const diff = Math.round((PRICES[to] - PRICES[from]) * periodLeft(c, now));
  const sub = `subscription/${c.id}`;
  const immediate: Plan = {
    summary: `${c.name}: ${from} → ${to} now, ${diff > 0 ? `charge ${usd(diff)} prorated` : `credit ${usd(-diff)} to next invoice`}`,
    effects: [
      update(sub, 'plan', from, to),
      diff > 0
        ? create('charge', `${usd(diff)} prorated to ${c.card}`)
        : update(`customer/${c.id}`, 'credit', '0.00 USD', usd(-diff)),
      send(c.email, 'plan change receipt'),
    ],
    ...(diff > 0 ? { uses: spent(diff) } : {}),
    undoWindow: 86400,
    apply: () => {
      c.plan = to;

      return { plan: to };
    },
    revert: () => {
      c.plan = from;
    },
  };
  const later: Plan = {
    summary: `${c.name}: ${from} → ${to} on ${date(c.renews)}, nothing charged today`,
    effects: [update(sub, 'plan', from, to, `from ${date(c.renews)}`)],
    undoWindow: Math.floor((c.renews - now) / 1000),
    // Scheduled, not applied: until renewal the customer is still on (and billed for) the old plan.
    apply: () => {
      c.nextPlan = to;

      return { plan: to, from: date(c.renews) };
    },
    revert: () => {
      c.nextPlan = null;
    },
  };

  return [immediate, later];
}

export function cancelPlans(c: Customer, now: number): Plan[] {
  if (c.status === 'canceled') {
    return fail('conflict', `${c.name} is already canceled`);
  }

  const sub = `subscription/${c.id}`;
  const atPeriodEnd: Plan = {
    summary: `Cancel ${c.name} on ${date(c.renews)}; access until then`,
    effects: [
      update(sub, 'cancels', null, date(c.renews)),
      send(c.email, 'cancellation confirmation'),
    ],
    // Reversible until the period ends: the customer can simply stay.
    undoWindow: Math.floor((c.renews - now) / 1000),
    apply: () => {
      c.cancelAt = c.renews;

      return { cancels: date(c.renews) };
    },
    revert: () => {
      c.cancelAt = null;
    },
  };
  const immediately: Plan = {
    summary: `Cancel ${c.name} now; access ends immediately, no refund`,
    effects: [
      update(sub, 'status', c.status, 'canceled'),
      send(c.email, 'cancellation confirmation'),
    ],
    risk: 'medium',
    apply: () => {
      c.status = 'canceled';

      return { status: 'canceled' };
    },
  };

  return [atPeriodEnd, immediately];
}
