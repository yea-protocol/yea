/**
 * `cancel_subscription`: at period end (undoable until a day before it), or now (not undoable).
 * A subscription on a schedule is cancelled at period end through the schedule, since Stripe
 * manages its cancellation there.
 */
import { type Effect, type JobPlan, update } from '@yea-protocol/sdk';
import { type Customer, period, type Subscription } from './api.js';
import {
  applying,
  type Ctx,
  day,
  type JobSpec,
  riskFor,
  tag,
  undoWindowBefore,
} from './context.js';
import { oneCustomer, oneItem, oneSubscription, priceName } from './find.js';
import { getSchedule, onlyCurrentPhase, type Schedule } from './schedule.js';
import { confirmPhrase, who } from './text.js';

export interface CancelInput {
  customer: string;
  subscription?: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    customer: {
      type: 'string',
      description: "The customer's name, email or cus_ id.",
    },
    subscription: {
      type: 'string',
      description: 'The sub_ id, if the customer has more than one.',
    },
  },
  required: ['customer'],
  additionalProperties: false,
};

const SUB_ID = /^sub_[A-Za-z0-9]+$/;
const SCHEDULE_ID = /^sub_sched_[A-Za-z0-9]+$|^sch_[A-Za-z0-9]+$/;

interface Target {
  c: Customer;
  sub: Subscription;
  /** The schedule, when the subscription has one. */
  schedule: Schedule | null;
}

const whose = (t: Target) =>
  `${who(t.c)}'s ${priceName(oneItem(t.sub).price)} subscription (${t.sub.id})`;

/** What at-period-end does: a subscription flag, or the schedule's end behaviour. */
function periodEndChange(t: Target): {
  effect: Effect;
  write(ctx: Ctx): Promise<Record<string, string>>;
} {
  const { end } = period(t.sub);
  const s = t.schedule;

  if (s) {
    return {
      effect: update(
        `subscription_schedule/${s.id}`,
        'end_behavior',
        'release',
        'cancel',
        `${t.sub.id} ends ${day(end)}`,
      ),
      write: async (ctx) => {
        await ctx.stripe.write('POST', `/subscription_schedules/${s.id}`, {
          end_behavior: 'cancel',
        });

        return { schedule: s.id, subscription: t.sub.id };
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
      await ctx.stripe.write('POST', `/subscriptions/${t.sub.id}`, {
        cancel_at_period_end: true,
      });

      return { subscription: t.sub.id };
    },
  };
}

function atPeriodEnd(ctx: Ctx, t: Target): JobPlan {
  const { end } = period(t.sub);
  const change = periodEndChange(t);
  const undoWindow = undoWindowBefore(ctx, end);

  return {
    summary: `${tag(ctx)} Cancel ${whose(t)} at period end, ${day(end)}; access until then`,
    effects: [change.effect],
    risk: riskFor(ctx, 'low'),
    ...(undoWindow === undefined ? {} : { undoWindow }),
    data: { confirm: confirmPhrase(t.c) },
    apply: () =>
      applying(async () => ({
        plan: 'cancel_at_period_end',
        ...(await change.write(ctx)),
      })),
  };
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
        await ctx.stripe.write('DELETE', `/subscriptions/${t.sub.id}`);

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

  if (t.sub.cancel_at_period_end || (t.sub.cancel_at ?? null) !== null) {
    return false;
  }

  return (
    !s ||
    (s.end_behavior === 'release' && onlyCurrentPhase(s, period(t.sub).end))
  );
}

async function cancelPlans(ctx: Ctx, input: CancelInput) {
  const c = await oneCustomer(ctx, input);

  if ('clarify' in c) {
    return c.clarify;
  }

  const sub = await oneSubscription(ctx, c.found, input);

  if ('clarify' in sub) {
    return sub.clarify;
  }

  oneItem(sub.found);

  const t: Target = {
    c: c.found,
    sub: sub.found,
    schedule: sub.found.schedule
      ? await getSchedule(ctx, sub.found.schedule)
      : null,
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

    return ctx.stripe.write('POST', `/subscription_schedules/${r.schedule}`, {
      end_behavior: 'release',
    });
  }

  return ctx.stripe.write('POST', `/subscriptions/${r.subscription}`, {
    cancel_at_period_end: false,
  });
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
