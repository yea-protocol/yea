/**
 * `cancel_subscription`: at period end (undoable until a day before it), or now (not undoable).
 * A subscription on a schedule is cancelled at period end through the schedule, since Stripe
 * manages its cancellation there.
 */
import { type Effect, type JobPlan, update } from '@yea-protocol/sdk';
import {
  cancelling,
  idOf,
  period,
  SCHEDULE_ID,
  type Stripe,
  StripeError,
  SUB_ID,
} from './api.js';
import {
  applying,
  type Ctx,
  day,
  type JobSpec,
  riskFor,
  tag,
  undoWindowBefore,
} from './context.js';
import {
  inputSchema,
  oneCustomerSubscription,
  oneItem,
  priceName,
  SUBSCRIPTION_FIELD,
} from './find.js';
import { getSchedule, onlyCurrentPhase } from './schedule.js';
import { confirmPhrase, who } from './text.js';

interface CancelInput {
  customer: string;
  subscription?: string;
}

const SCHEMA = inputSchema({ subscription: SUBSCRIPTION_FIELD });

interface Target {
  c: Stripe.Customer;
  sub: Stripe.Subscription;
  /** The schedule, when the subscription has one. */
  schedule: Stripe.SubscriptionSchedule | null;
}

const whose = (t: Target) =>
  `${who(t.c)}'s ${priceName(oneItem(t.sub).price)} subscription (${t.sub.id})`;

/** What at-period-end does: a subscription flag, or the schedule's end behaviour. */
function periodEndChange(t: Target): {
  effect: Effect;
  write(ctx: Ctx): Promise<Record<string, string>>;
} {
  const { end } = period(t.sub);
  const sched = t.schedule;

  if (sched) {
    return {
      effect: update(
        `subscription_schedule/${sched.id}`,
        'end_behavior',
        'release',
        'cancel',
        `${t.sub.id} ends ${day(end)}`,
      ),
      write: async (ctx) => {
        await ctx.stripe.write((s, o) =>
          s.subscriptionSchedules.update(
            sched.id,
            { end_behavior: 'cancel' },
            o,
          ),
        );

        return { schedule: sched.id, subscription: t.sub.id };
      },
    };
  }

  return {
    effect: update(
      `subscription/${t.sub.id}`,
      'cancel_at_period_end',
      false,
      true,
      `ends ${day(end)}`,
    ),
    write: async (ctx) => {
      await ctx.stripe.write((s, o) =>
        s.subscriptions.update(t.sub.id, { cancel_at_period_end: true }, o),
      );

      return { subscription: t.sub.id };
    },
  };
}

function atPeriodEnd(ctx: Ctx, t: Target): JobPlan {
  const { end } = period(t.sub);
  const change = periodEndChange(t);

  return {
    summary: `${tag(ctx)} Cancel ${whose(t)} at period end, ${day(end)}; access until then`,
    effects: [change.effect],
    risk: riskFor(ctx, 'low'),
    ...undoWindowBefore(ctx, end),
    data: { confirm: confirmPhrase(t.c) },
    apply: () =>
      applying(async () => ({
        plan: 'cancel_at_period_end',
        ...(await change.write(ctx)),
      })),
  };
}

/** Whether Stripe says the subscription is cancelled; a failed read says no. */
const isCancelled = (ctx: Ctx, id: string) =>
  ctx.stripe
    .read((s) => s.subscriptions.retrieve(id))
    .then(
      (sub) => sub.status === 'canceled',
      () => false,
    );

/**
 * Cancel at once. Stripe ignores idempotency keys on DELETE, so it isn't retried: a lost answer
 * is reported as unknown. The SDK still retries once after a reset connection, and if the first
 * try went through, that retry fails; so a plain failure is checked against the subscription,
 * and one that's cancelled counts as done.
 */
async function cancelNow(ctx: Ctx, id: string) {
  try {
    await ctx.stripe.write((s, o) =>
      s.subscriptions.cancel(id, {}, { ...o, maxNetworkRetries: 0 }),
    );
  } catch (e) {
    if (
      !(e instanceof StripeError) ||
      e.unknown ||
      !(await isCancelled(ctx, id))
    ) {
      throw e;
    }
  }
}

function now(ctx: Ctx, t: Target): JobPlan {
  return {
    summary: `${tag(ctx)} Cancel ${whose(t)} now; access ends immediately, with no refund`,
    effects: [
      update(`subscription/${t.sub.id}`, 'status', t.sub.status, 'canceled'),
    ],
    risk: riskFor(ctx, 'medium'),
    data: { confirm: confirmPhrase(t.c) },
    apply: () =>
      applying(async () => {
        await cancelNow(ctx, t.sub.id);

        return { plan: 'cancel_now', subscription: t.sub.id };
      }),
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

async function cancelPlans(ctx: Ctx, input: CancelInput) {
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

/** Undo "at period end", from what `apply()` returned. */
async function revertCancel(ctx: Ctx, result: unknown) {
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

export function cancelJob(ctx: Ctx): JobSpec<CancelInput> {
  return {
    name: 'cancel_subscription',
    title: 'Cancel a subscription',
    description:
      "Cancel a customer's subscription, for the Stripe API: at period end (undoable until a day before it), or now (not undoable). The user approves by typing the customer's email.",
    schema: SCHEMA,
    risk: riskFor(ctx, 'low'),
    plan: (input) => cancelPlans(ctx, input),
    revert: (_input, result) => revertCancel(ctx, result),
  };
}
