/**
 * Cancelling at period end, as one choice: whether it can be offered, and the effect a plan
 * discloses and the write `apply()` makes, which come from the same branch (the schedule's end
 * behaviour, or the subscription's flag), so they can't drift apart.
 */
import { type Effect, update } from '@yea-protocol/sdk';
import { cancelling, period, type Stripe } from '../../api.js';
import { type Ctx, day } from '../../context.js';
import { onlyCurrentPhase } from '../../schedule.js';

/** What at-period-end changes, and the write that changes it. */
export interface PeriodEnd {
  effect: Effect;
  write(ctx: Ctx): Promise<Record<string, string>>;
}

/**
 * Whether "at period end" can be offered: not when it's already cancelling, and on a schedule
 * only when nothing else is pending, so ending the schedule ends the current period.
 */
export function canEndAtPeriodEnd(
  sub: Stripe.Subscription,
  sched: Stripe.SubscriptionSchedule | null,
): boolean {
  if (cancelling(sub)) {
    return false;
  }

  return (
    !sched ||
    (sched.end_behavior === 'release' &&
      onlyCurrentPhase(sched, period(sub).end))
  );
}

/** What at-period-end does: a subscription flag, or the schedule's end behaviour. */
export function periodEnd(
  sub: Stripe.Subscription,
  sched: Stripe.SubscriptionSchedule | null,
): PeriodEnd {
  const { end } = period(sub);

  if (sched) {
    return {
      effect: update(
        `subscription_schedule/${sched.id}`,
        'end_behavior',
        'release',
        'cancel',
        `${sub.id} ends ${day(end)}`,
      ),
      write: async (ctx) => {
        await ctx.stripe.write((s, o) =>
          s.subscriptionSchedules.update(
            sched.id,
            { end_behavior: 'cancel' },
            o,
          ),
        );

        return { schedule: sched.id, subscription: sub.id };
      },
    };
  }

  return {
    effect: update(
      `subscription/${sub.id}`,
      'cancel_at_period_end',
      false,
      true,
      `ends ${day(end)}`,
    ),
    write: async (ctx) => {
      await ctx.stripe.write((s, o) =>
        s.subscriptions.update(sub.id, { cancel_at_period_end: true }, o),
      );

      return { subscription: sub.id };
    },
  };
}
