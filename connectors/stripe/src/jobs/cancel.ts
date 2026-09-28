/**
 * `cancel_subscription`: at period end (undoable until a day before it), or now (not undoable).
 * A subscription on a schedule is cancelled at period end through the schedule, since Stripe
 * manages its cancellation there.
 */
import { type JobPlan, update } from '@yea-protocol/sdk';
import {
  cancelling,
  idOf,
  period,
  SCHEDULE_ID,
  type Stripe,
  SUB_ID,
} from '../api.js';
import {
  applying,
  type Ctx,
  day,
  type JobSpec,
  riskFor,
  tag,
  undoWindowBefore,
} from '../context.js';
import {
  inputSchema,
  oneCustomerSubscription,
  oneItem,
  priceName,
  SUBSCRIPTION_FIELD,
} from '../find.js';
import { getSchedule, onlyCurrentPhase } from '../schedule.js';
import { confirmPhrase, who } from '../text.js';
import { cancelNow } from './cancel/now.js';
import { type PeriodEnd, periodEnd } from './cancel/period-end.js';

// --- input schema ---

interface CancelInput {
  customer: string;
  subscription?: string;
}

const SCHEMA = inputSchema({ subscription: SUBSCRIPTION_FIELD });

// --- plan() ---

interface Target {
  c: Stripe.Customer;
  sub: Stripe.Subscription;
  /** The schedule, when the subscription has one. */
  schedule: Stripe.SubscriptionSchedule | null;
}

const whose = (t: Target) =>
  `${who(t.c)}'s ${priceName(oneItem(t.sub).price)} subscription (${t.sub.id})`;

/** Cancel at period end: access until then, undoable until a day before it. */
function atPeriodEnd(ctx: Ctx, t: Target): JobPlan {
  const { end } = period(t.sub);
  const change = periodEnd(t.sub, t.schedule);

  return {
    summary: `${tag(ctx)} Cancel ${whose(t)} at period end, ${day(end)}; access until then`,
    effects: [change.effect],
    risk: riskFor(ctx, 'low'),
    ...undoWindowBefore(ctx, end),
    data: { confirm: confirmPhrase(t.c) },
    apply: () => applyAtPeriodEnd(ctx, change),
  };
}

/** Cancel now: access ends at once, and it can't be undone. */
function now(ctx: Ctx, t: Target): JobPlan {
  return {
    summary: `${tag(ctx)} Cancel ${whose(t)} now; access ends immediately, with no refund`,
    effects: [
      update(`subscription/${t.sub.id}`, 'status', t.sub.status, 'canceled'),
    ],
    risk: riskFor(ctx, 'medium'),
    data: { confirm: confirmPhrase(t.c) },
    apply: () => applyNow(ctx, t),
  };
}

/**
 * Whether "at period end" can be offered: not when it's already cancelling, and on a schedule
 * only when nothing else is pending, so ending the schedule ends the current period.
 */
function canEndAtPeriodEnd(t: Target): boolean {
  const s = t.schedule;

  if (cancelling(t.sub)) {
    return false;
  }

  return (
    !s ||
    (s.end_behavior === 'release' && onlyCurrentPhase(s, period(t.sub).end))
  );
}

/** The cancellation plans: at period end when it can be offered, and now. */
async function plan(ctx: Ctx, input: CancelInput) {
  const found = await oneCustomerSubscription(ctx, input);

  if ('clarify' in found) {
    return found.clarify;
  }

  const { c, sub } = found.found;

  oneItem(sub);

  const t: Target = {
    c,
    sub,
    schedule: sub.schedule ? await getSchedule(ctx, idOf(sub.schedule)) : null,
  };

  return canEndAtPeriodEnd(t)
    ? [atPeriodEnd(ctx, t), now(ctx, t)]
    : [now(ctx, t)];
}

// --- apply() ---

/** Make the at-period-end write the plan disclosed. */
function applyAtPeriodEnd(ctx: Ctx, change: PeriodEnd) {
  return applying(async () => ({
    plan: 'cancel_at_period_end',
    ...(await change.write(ctx)),
  }));
}

/** Cancel the subscription at once. */
function applyNow(ctx: Ctx, t: Target) {
  return applying(async () => {
    await cancelNow(ctx, t.sub.id);

    return { plan: 'cancel_now', subscription: t.sub.id };
  });
}

// --- revert() ---

/** Undo "at period end", from what `apply()` returned. */
async function revert(ctx: Ctx, result: unknown) {
  const r = (result ?? {}) as {
    plan?: unknown;
    subscription?: unknown;
    schedule?: unknown;
  };

  if (
    r.plan !== 'cancel_at_period_end' ||
    typeof r.subscription !== 'string' ||
    !SUB_ID.test(r.subscription)
  ) {
    throw new Error("this cancellation can't be undone");
  }

  if (r.schedule !== undefined) {
    if (typeof r.schedule !== 'string' || !SCHEDULE_ID.test(r.schedule)) {
      throw new Error("this cancellation's schedule id is malformed");
    }

    const schedule = r.schedule;

    return applying(() =>
      ctx.stripe.write((s, o) =>
        s.subscriptionSchedules.update(
          schedule,
          { end_behavior: 'release' },
          o,
        ),
      ),
    );
  }

  const sub = r.subscription;

  return applying(() =>
    ctx.stripe.write((s, o) =>
      s.subscriptions.update(sub, { cancel_at_period_end: false }, o),
    ),
  );
}

// --- the job ---

/** The `cancel_subscription` job, before `server.ts` registers it. */
export function cancelJob(ctx: Ctx): JobSpec<CancelInput> {
  return {
    name: 'cancel_subscription',
    title: 'Cancel a subscription',
    description:
      "Cancel a customer's subscription, for the Stripe API: at period end (undoable until a day before it), or now (not undoable). The user approves by typing the customer's email.",
    schema: SCHEMA,
    risk: riskFor(ctx, 'low'),
    plan: (input) => plan(ctx, input),
    revert: (_input, result) => revert(ctx, result),
  };
}
