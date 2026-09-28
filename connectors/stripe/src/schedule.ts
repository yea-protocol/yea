/**
 * Subscription schedules: how a plan change waits for renewal, and how a subscription that has
 * one is cancelled. Creating a schedule with phases takes two writes (Stripe doesn't allow
 * phases with `from_subscription`), so a failure between them is cleaned up here.
 */
import { PartialApplyError } from '@yea-protocol/mcp';
import { type FormValue, type Price, StripeError } from './api.js';
import { applying, type Ctx } from './context.js';

type Ref = string | { id: string };

export interface SchedulePhase {
  start_date: number;
  end_date: number | null;
  items: {
    price: Ref;
    quantity?: number;
    tax_rates?: Ref[] | null;
    metadata?: Record<string, string> | null;
  }[];
  collection_method?: string | null;
  default_payment_method?: Ref | null;
  default_tax_rates?: Ref[] | null;
  description?: string | null;
  metadata?: Record<string, string> | null;
  currency?: string | null;
  trial_end?: number | null;
  discounts?: unknown[] | null;
}

export interface Schedule {
  id: string;
  subscription: string | null;
  status: string;
  end_behavior: string;
  phases: SchedulePhase[];
  current_phase: { start_date: number; end_date: number } | null;
}

const idOf = (r: Ref) => (typeof r === 'string' ? r : r.id);

const ids = (rs: Ref[] | null | undefined) => (rs ?? []).map(idOf);

export const getSchedule = (ctx: Ctx, id: string) =>
  ctx.stripe.get<Schedule>(`/subscription_schedules/${id}`);

/** Whether the schedule is in its last phase, ending at `end`: nothing else is pending. */
export function onlyCurrentPhase(s: Schedule, end: number): boolean {
  const last = s.phases.at(-1);

  return (
    s.current_phase !== null &&
    last !== undefined &&
    last.start_date === s.current_phase.start_date &&
    last.end_date === end
  );
}

/** The settings a phase carries that the new phase keeps too. */
function billingOf(p: SchedulePhase): Record<string, FormValue> {
  return {
    collection_method: p.collection_method ?? undefined,
    default_payment_method: p.default_payment_method
      ? idOf(p.default_payment_method)
      : undefined,
    default_tax_rates: ids(p.default_tax_rates),
    currency: p.currency ?? undefined,
  };
}

/** The current phase, copied in full so the update leaves it as Stripe made it. */
function copyPhase(p: SchedulePhase): Record<string, FormValue> {
  return {
    ...billingOf(p),
    start_date: p.start_date,
    end_date: p.end_date ?? undefined,
    trial_end: p.trial_end ?? undefined,
    description: p.description ?? undefined,
    metadata: p.metadata ?? undefined,
    items: p.items.map((i) => ({
      price: idOf(i.price),
      quantity: i.quantity,
      tax_rates: ids(i.tax_rates),
      metadata: i.metadata ?? undefined,
    })),
  };
}

/** The phase that starts at renewal: the new price for one billing period, then release. */
function nextPhase(
  current: SchedulePhase,
  price: Price,
  quantity: number,
): Record<string, FormValue> {
  const every = price.recurring;

  if (!every) {
    throw new Error(`${price.id} isn't a recurring price`);
  }

  return {
    ...billingOf(current),
    items: [
      {
        price: price.id,
        quantity,
        tax_rates: ids(current.items[0]?.tax_rates),
      },
    ],
    duration: {
      interval: every.interval,
      interval_count: every.interval_count,
    },
    proration_behavior: 'none',
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Release a schedule: the subscription stays as it is, and pending phases are dropped. */
export const releaseSchedule = (ctx: Ctx, id: string) =>
  ctx.stripe.write<Schedule>('POST', `/subscription_schedules/${id}/release`);

/**
 * The second write failed, or its result is unknown: release the schedule, so nothing is left
 * pending. If that fails too, say which `sch_…` was left, never "nothing changed".
 */
async function cleanUp(
  ctx: Ctx,
  s: { schedule: string; subscription: string },
  failed: unknown,
): Promise<never> {
  try {
    await releaseSchedule(ctx, s.schedule);
  } catch (e) {
    throw new PartialApplyError(
      `adding the new phase failed (${message(failed)}), and releasing schedule ${s.schedule} failed too (${message(e)}). ${s.subscription} is left on subscription schedule ${s.schedule}: release it in the Stripe dashboard, or with POST /v1/subscription_schedules/${s.schedule}/release.`,
    );
  }

  throw new Error(
    `adding the new phase failed (${message(failed)}); schedule ${s.schedule} was released, so the subscription is as it was`,
  );
}

/**
 * Change the price at renewal: create a schedule from the subscription, then add a phase with
 * the new price from the renewal date. Returns the ids `revert` needs.
 */
export async function changeAtRenewal(
  ctx: Ctx,
  o: { subscription: string; price: Price; quantity: number },
) {
  const made = await applying(() =>
    ctx.stripe.write<Schedule>('POST', '/subscription_schedules', {
      from_subscription: o.subscription,
    }),
  );
  const [current] = made.phases;
  const where = { schedule: made.id, subscription: o.subscription };

  try {
    if (!current) {
      throw new StripeError(`${made.id} came back with no phases`, {
        status: 0,
      });
    }

    await ctx.stripe.write('POST', `/subscription_schedules/${made.id}`, {
      end_behavior: 'release',
      phases: [copyPhase(current), nextPhase(current, o.price, o.quantity)],
      metadata: { created_by: 'yea-stripe' },
    });
  } catch (e) {
    return cleanUp(ctx, where, e);
  }

  return { plan: 'change_at_renewal', ...where, price: o.price.id };
}
