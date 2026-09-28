/**
 * Cancelling at period end, as one choice: the effect a plan discloses and the write `apply()`
 * makes come from the same branch (the schedule's end behaviour, or the subscription's flag),
 * so they can't drift apart.
 */
import { type Effect, update } from '@yea-protocol/sdk';
import { period, type Stripe } from '../../api.js';
import { type Ctx, day } from '../../context.js';

/** What at-period-end changes, and the write that changes it. */
export interface PeriodEnd {
  effect: Effect;
  write(ctx: Ctx): Promise<Record<string, string>>;
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
