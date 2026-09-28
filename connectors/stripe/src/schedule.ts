/**
 * Subscription schedules: how a plan change waits for renewal, and how a subscription that has
 * one is cancelled. Creating a schedule with phases takes two writes (Stripe doesn't allow
 * phases with `from_subscription`), so a failure between them is cleaned up here.
 */
import { PartialApplyError } from '@yea-protocol/mcp';
import { idOf, type Stripe, StripeError } from './api.js';
import { applying, type Ctx } from './context.js';

type Phase = Stripe.SubscriptionSchedule.Phase;
type NewPhase = Stripe.SubscriptionScheduleUpdateParams.Phase;

const ids = (rs: { id: string }[] | null | undefined) => (rs ?? []).map(idOf);

export const getSchedule = (ctx: Ctx, id: string) =>
  ctx.stripe.read((s) => s.subscriptionSchedules.retrieve(id));

/** Whether the schedule is in its last phase, ending at `end`: nothing else is pending. */
export function onlyCurrentPhase(
  s: Stripe.SubscriptionSchedule,
  end: number,
): boolean {
  const last = s.phases.at(-1);

  return (
    s.current_phase !== null &&
    last !== undefined &&
    last.start_date === s.current_phase.start_date &&
    last.end_date === end
  );
}

/** The settings a phase carries that the new phase keeps too. */
function billingOf(p: Phase) {
  return {
    collection_method: p.collection_method ?? undefined,
    default_payment_method: p.default_payment_method
      ? idOf(p.default_payment_method)
      : undefined,
    default_tax_rates: ids(p.default_tax_rates),
    currency: p.currency,
  };
}

/** The current phase, copied in full so the update leaves it as Stripe made it. */
function copyPhase(p: Phase): NewPhase {
  return {
    ...billingOf(p),
    start_date: p.start_date,
    end_date: p.end_date,
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
  current: Phase,
  price: Stripe.Price,
  quantity: number,
): NewPhase {
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

/** Whether an invoice_settings value holds anything besides the defaults. */
function customInvoiceSettings(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) {
    return false;
  }

  const o = v as Record<string, unknown>;
  const issuer = o.issuer as { type?: unknown } | null | undefined;

  return (
    (Array.isArray(o.account_tax_ids) && o.account_tax_ids.length > 0) ||
    (o.days_until_due ?? null) !== null ||
    (issuer !== null && issuer !== undefined && issuer.type !== 'self')
  );
}

/** Whether a setting is on: present, not empty, and for automatic tax, enabled. */
function isSet(k: string, v: unknown): boolean {
  if (k === 'automatic_tax') {
    return (v as { enabled?: unknown } | null)?.enabled === true;
  }

  if (k === 'invoice_settings') {
    return customInvoiceSettings(v);
  }

  return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined;
}

const UNCOPIED = [
  'automatic_tax',
  'invoice_settings',
  'billing_thresholds',
  'on_behalf_of',
  'transfer_data',
  'application_fee_percent',
  'add_invoice_items',
];

/**
 * Settings a subscription or phase can carry that the phase copy doesn't. Their schedule
 * semantics aren't confirmed, so "at renewal" is refused when any is set, rather than risk
 * dropping one.
 */
export function uncopied(o: object): string[] {
  const r = o as Record<string, unknown>;

  return UNCOPIED.filter((k) => isSet(k, r[k]));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Release a schedule: the subscription stays as it is, and pending phases are dropped. */
export const releaseSchedule = (ctx: Ctx, id: string) =>
  ctx.stripe.write((s, o) => s.subscriptionSchedules.release(id, {}, o));

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
  o: { subscription: string; price: Stripe.Price; quantity: number },
) {
  const made = await applying(() =>
    ctx.stripe.write((s, opts) =>
      s.subscriptionSchedules.create(
        { from_subscription: o.subscription },
        opts,
      ),
    ),
  );
  const [current] = made.phases;
  const where = { schedule: made.id, subscription: o.subscription };

  try {
    if (!current) {
      throw new StripeError(`${made.id} came back with no phases`, {
        status: 0,
      });
    }

    const extra = uncopied(current);

    if (extra.length) {
      throw new Error(
        `its current phase has ${extra.join(', ')}, which a change at renewal can't copy yet`,
      );
    }

    await ctx.stripe.write((s, opts) =>
      s.subscriptionSchedules.update(
        made.id,
        {
          end_behavior: 'release',
          phases: [copyPhase(current), nextPhase(current, o.price, o.quantity)],
          metadata: { created_by: 'yea-stripe' },
        },
        opts,
      ),
    );
  } catch (e) {
    return cleanUp(ctx, where, e);
  }

  return { plan: 'change_at_renewal', ...where, price: o.price.id };
}
