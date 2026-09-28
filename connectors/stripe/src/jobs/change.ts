/**
 * `change_plan`: at renewal (a schedule, undoable until a day before it) or now, prorated (not
 * undoable). "Now" is previewed with `create_preview` at a proration date fixed to the start of
 * today, and the update sends that same date, so the charge is the one the person approved.
 */
import { PartialApplyError } from '@yea-protocol/mcp';
import { create, type JobPlan, type Risk, update } from '@yea-protocol/sdk';
import { cancelling, idOf, period, SCHEDULE_ID, type Stripe } from '../api.js';
import {
  applying,
  type Ctx,
  day,
  type JobSpec,
  riskFor,
  tag,
  today,
  undoWindowBefore,
} from '../context.js';
import {
  inputSchema,
  oneCustomerSubscription,
  oneItem,
  priceLabel,
  priceName,
  SUBSCRIPTION_FIELD,
} from '../find.js';
import {
  changeAtRenewal,
  getSchedule,
  onlyCurrentPhase,
  releaseSchedule,
  uncopied,
} from '../schedule.js';
import { confirmPhrase, who } from '../text.js';
import { cheaperOrSame, findPrice, refuseUnsafe } from './change/prices.js';
import { proration } from './change/proration.js';

// --- input schema ---

interface ChangeInput {
  customer: string;
  price: string;
  subscription?: string;
}

const SCHEMA = inputSchema(
  {
    price: {
      type: 'string',
      description: 'The new price: its price_ id or lookup key.',
    },
    subscription: SUBSCRIPTION_FIELD,
  },
  ['price'],
);

// --- plan() ---

interface Change {
  c: Stripe.Customer;
  sub: Stripe.Subscription;
  item: Stripe.SubscriptionItem;
  to: Stripe.Price;
  quantity: number;
}

/** What "now" sends, and previews: the item at its new price, prorated from `date`. */
interface Prorated {
  items: { id: string; price: string; quantity: number }[];
  date: number;
}

const discounted = (ch: Change) =>
  ch.sub.discounts.length > 0 || ch.item.discounts.length > 0;

const moving = (ctx: Ctx, ch: Change) =>
  `${tag(ctx)} Move ${who(ch.c)}'s subscription (${ch.sub.id}) from ${priceLabel(ch.item.price)} to ${priceLabel(ch.to)}`;

/** Change at renewal: a schedule, undoable until a day before it. */
function atRenewal(ctx: Ctx, ch: Change): JobPlan {
  const { end } = period(ch.sub);
  const risk: Risk = riskFor(
    ctx,
    cheaperOrSame(ch.item.price, ch.to) ? 'low' : 'medium',
  );

  return {
    summary: `${moving(ctx, ch)} at renewal, ${day(end)}`,
    effects: [
      create(
        'subscription_schedule',
        `for ${ch.sub.id}: ${priceName(ch.item.price)} until ${day(end)}, then ${priceName(ch.to)} × ${ch.quantity}`,
      ),
    ],
    risk,
    ...undoWindowBefore(ctx, end),
    data: { confirm: confirmPhrase(ch.c) },
    apply: () => applyAtRenewal(ctx, ch),
  };
}

/** Change now, prorated: previewed at the same date and items `apply()` sends. */
async function now(ctx: Ctx, ch: Change): Promise<JobPlan> {
  const prorated: Prorated = {
    items: [{ id: ch.item.id, price: ch.to.id, quantity: ch.quantity }],
    date: Math.max(today(ctx), period(ch.sub).start),
  };
  const preview = await ctx.stripe.read((s) =>
    s.invoices.createPreview({
      subscription: ch.sub.id,
      subscription_details: {
        items: prorated.items,
        proration_behavior: 'always_invoice',
        proration_date: prorated.date,
      },
    }),
  );
  const p = proration(preview, priceName(ch.item.price));

  return {
    summary: `${moving(ctx, ch)} now; ${p.says}`,
    effects: [
      update(
        `subscription/${ch.sub.id}`,
        'price',
        ch.item.price.id,
        ch.to.id,
        `prorated from ${day(prorated.date)}`,
      ),
      ...(p.effect ? [p.effect] : []),
    ],
    ...(p.uses ? { uses: p.uses } : {}),
    risk: riskFor(ctx, 'medium'),
    data: { confirm: confirmPhrase(ch.c) },
    apply: () => applyNow(ctx, ch, prorated),
  };
}

/**
 * Which plans a subscription can have. With a schedule: never "at renewal" (releasing would drop
 * phases we didn't make), and "now" only when nothing else is pending, since a later phase
 * would undo it.
 */
async function whatFits(ctx: Ctx, ch: Change) {
  if (!ch.sub.schedule) {
    return {
      renewal:
        !cancelling(ch.sub) && !discounted(ch) && uncopied(ch.sub).length === 0,
      now: true,
    };
  }

  const s = await getSchedule(ctx, idOf(ch.sub.schedule));

  if (!onlyCurrentPhase(s, period(ch.sub).end)) {
    throw new Error(
      `${ch.sub.id} has changes pending on subscription schedule ${s.id}; undo that change or edit the schedule in the Stripe dashboard first`,
    );
  }

  return { renewal: false, now: true };
}

/**
 * A change already waiting on payment refuses both plans: another "now" would make a second
 * update and a second invoice, and "at renewal" would race the one pending.
 */
function refusePending(sub: Stripe.Subscription) {
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

/** The plan-change plans: at renewal when it fits, and now. */
async function plan(ctx: Ctx, input: ChangeInput) {
  const found = await oneCustomerSubscription(ctx, input);

  if ('clarify' in found) {
    return found.clarify;
  }

  const { c, sub } = found.found;

  refusePending(sub);

  const item = oneItem(sub);
  const to = await findPrice(ctx, input.price);

  refuseUnsafe(item.price, to);

  const ch: Change = { c, sub, item, to, quantity: item.quantity ?? 1 };
  const fits = await whatFits(ctx, ch);
  const plans = fits.renewal ? [atRenewal(ctx, ch)] : [];

  plans.push(await now(ctx, ch));

  return plans;
}

// --- apply() ---

/** "At renewal": a schedule that moves to the new price from the renewal date. */
function applyAtRenewal(ctx: Ctx, ch: Change) {
  return changeAtRenewal(ctx, {
    subscription: ch.sub.id,
    price: ch.to,
    quantity: ch.quantity,
  });
}

/** "Now": the prorated update, at the date and items the preview used. */
function applyNow(ctx: Ctx, ch: Change, prorated: Prorated) {
  return applying(async () => {
    // A declined payment leaves the update pending, not the new price on an unpaid invoice.
    const sub = await ctx.stripe.write((s, o) =>
      s.subscriptions.update(
        ch.sub.id,
        {
          items: prorated.items,
          proration_behavior: 'always_invoice',
          proration_date: prorated.date,
          payment_behavior: 'pending_if_incomplete',
        },
        o,
      ),
    );

    // Not a success: the invoice exists, but the change waits on its payment.
    if (sub.pending_update !== null) {
      throw new PartialApplyError(
        `Stripe invoiced the change, but the payment didn't go through, so the change is pending, not made. If the invoice isn't paid within about 23 hours, Stripe discards the change and ${ch.sub.id} stays on ${priceName(ch.item.price)}.`,
      );
    }

    return { plan: 'change_now', subscription: ch.sub.id, price: ch.to.id };
  });
}

// --- revert() ---

/** Undo "at renewal": release the schedule `apply()` created. */
async function revert(ctx: Ctx, result: unknown) {
  const r = (result ?? {}) as { plan?: unknown; schedule?: unknown };

  if (
    r.plan !== 'change_at_renewal' ||
    typeof r.schedule !== 'string' ||
    !SCHEDULE_ID.test(r.schedule)
  ) {
    throw new Error("this plan change can't be undone");
  }

  const schedule = r.schedule;

  return applying(() => releaseSchedule(ctx, schedule));
}

// --- the job ---

/** The `change_plan` job, before `server.ts` registers it. */
export function changeJob(ctx: Ctx): JobSpec<ChangeInput> {
  return {
    name: 'change_plan',
    title: 'Change a subscription plan',
    description:
      "Move a customer's subscription to another price, for the Stripe API: at renewal (undoable until a day before it), or now with proration (charges or credits at once; not undoable). The user approves by typing the customer's email.",
    schema: SCHEMA,
    risk: riskFor(ctx, 'medium'),
    plan: (input) => plan(ctx, input),
    revert: (_input, result) => revert(ctx, result),
  };
}
