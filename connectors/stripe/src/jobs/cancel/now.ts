/**
 * Cancelling at once: a DELETE Stripe won't deduplicate, so it isn't retried, and a failure is
 * checked against the subscription before it counts as one.
 */
import { StripeError } from '../../api.js';
import type { Ctx } from '../../context.js';

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
export async function cancelNow(ctx: Ctx, id: string) {
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
