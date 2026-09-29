/**
 * Which plan-change plans a subscription can have: "at renewal" only without a schedule, a
 * cancellation, discounts or settings a schedule wouldn't copy; neither while a change waits on
 * payment, or while a schedule has other changes pending.
 */
import { cancelling, idOf, period, type Stripe } from '../../api.js';
import type { Ctx } from '../../context.js';
import { getSchedule, onlyCurrentPhase, uncopied } from '../../schedule.js';

const discounted = (sub: Stripe.Subscription, item: Stripe.SubscriptionItem) =>
  sub.discounts.length > 0 || item.discounts.length > 0;

/**
 * Which plans a subscription can have. With a schedule: never "at renewal" (releasing would drop
 * phases we didn't make), and "now" only when nothing else is pending, since a later phase
 * would undo it.
 */
export async function whatFits(
  ctx: Ctx,
  sub: Stripe.Subscription,
  item: Stripe.SubscriptionItem,
) {
  if (!sub.schedule) {
    return {
      renewal:
        !cancelling(sub) &&
        !discounted(sub, item) &&
        uncopied(sub).length === 0,
      now: true,
    };
  }

  const s = await getSchedule(ctx, idOf(sub.schedule));

  if (!onlyCurrentPhase(s, period(sub).end)) {
    throw new Error(
      `${sub.id} has changes pending on subscription schedule ${s.id}; undo that change or edit the schedule in the Stripe dashboard first`,
    );
  }

  return { renewal: false, now: true };
}

/**
 * A change already waiting on payment refuses both plans: another "now" would make a second
 * update and a second invoice, and "at renewal" would race the one pending.
 */
export function refusePending(sub: Stripe.Subscription) {
  const pending = sub.pending_update;

  if (pending === null) {
    return;
  }

  const invoice =
    sub.latest_invoice === null ? 'its open invoice' : idOf(sub.latest_invoice);
  const until = pending.expires_at
    ? `, by ${new Date(pending.expires_at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : '';

  throw new Error(
    `${sub.id} already has a price change waiting on payment of ${invoice}. Stripe applies it once that invoice is paid, or discards it if it isn't${until}; nothing else can change the plan until then`,
  );
}
