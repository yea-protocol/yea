/**
 * `change_plan`: at renewal (a schedule, undoable until a day before it) or now, prorated (not
 * undoable). "Now" is previewed with `create_preview` at a proration date fixed to the start of
 * today, and the update sends that same date, so the charge is the one the person approved.
 */
import { PartialApplyError } from '@yea-protocol/mcp';
import { create, type JobPlan, type Risk, update } from '@yea-protocol/sdk';
import type Stripe from 'stripe';
import { idOf, period } from './api.js';
import {
  applying,
  type Ctx,
  day,
  type JobSpec,
  riskFor,
  startOfDay,
  tag,
  undoWindowBefore,
} from './context.js';
import { formatMoney, toQuantity } from './currency.js';
import {
  oneCustomer,
  oneItem,
  oneSubscription,
  priceLabel,
  priceName,
} from './find.js';
import {
  changeAtRenewal,
  getSchedule,
  onlyCurrentPhase,
  releaseSchedule,
  uncopied,
} from './schedule.js';
import { confirmPhrase, quoted, who } from './text.js';

export interface ChangeInput {
  customer: string;
  price: string;
  subscription?: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    customer: {
      type: 'string',
      description: "The customer's name, email or cus_ id.",
    },
    price: {
      type: 'string',
      description: 'The new price: its price_ id or lookup key.',
    },
    subscription: {
      type: 'string',
      description: 'The sub_ id, if the customer has more than one.',
    },
  },
  required: ['customer', 'price'],
  additionalProperties: false,
};

const SCHEDULE_ID = /^sub_sched_[A-Za-z0-9]+$|^sch_[A-Za-z0-9]+$/;

interface Change {
  c: Stripe.Customer;
  sub: Stripe.Subscription;
  item: Stripe.SubscriptionItem;
  to: Stripe.Price;
  quantity: number;
}

/** The price asked for: by id, or by lookup key among active prices. */
async function findPrice(ctx: Ctx, ref: string): Promise<Stripe.Price> {
  if (/^price_[A-Za-z0-9_]+$/.test(ref)) {
    const price = await ctx.stripe.read((s) => s.prices.retrieve(ref));

    if (price.active !== true) {
      throw new Error(`${ref} isn't an active price`);
    }

    return price;
  }

  const found = await ctx.stripe.read((s) =>
    s.prices.list({ lookup_keys: [ref], active: true }),
  );
  const [price, ...more] = found.data;

  if (!price || more.length) {
    throw new Error(
      `no single active price has lookup key ${quoted(ref)}; pass its price_ id`,
    );
  }

  return price;
}

/**
 * Refuse what v0 can't do safely: the same price, a price that isn't recurring, another
 * currency, or another billing interval (Stripe then resets the billing date and charges at
 * once, whatever the proration setting).
 */
function refuseUnsafe(from: Stripe.Price, to: Stripe.Price) {
  if (from.id === to.id) {
    throw new Error(`the subscription is already on ${priceLabel(to)}`);
  }

  if (!to.recurring || !from.recurring) {
    throw new Error(`${to.id} isn't a recurring price`);
  }

  if (from.currency !== to.currency) {
    throw new Error(
      `${to.id} is in ${to.currency.toUpperCase()}, and the subscription is in ${from.currency.toUpperCase()}; Stripe can't change a subscription's currency`,
    );
  }

  const every = (p: Stripe.Price) =>
    `${p.recurring?.interval_count ?? 1} ${p.recurring?.interval ?? '?'}`;

  if (every(from) !== every(to)) {
    throw new Error(
      `${priceLabel(to)} bills every ${every(to)}, and the subscription every ${every(from)}; changing the billing interval isn't supported yet, because Stripe resets the billing date and charges at once`,
    );
  }
}

/** Flat per-unit pricing: the only kind whose prices can be compared. */
const flat = (p: Stripe.Price) =>
  p.billing_scheme === 'per_unit' &&
  p.recurring?.usage_type === 'licensed' &&
  typeof p.unit_amount === 'number' &&
  p.transform_quantity === null;

/**
 * Cheaper or the same: both flat per-unit, in the same currency and interval, with the same
 * quantity, and the new unit amount no higher. Anything else can't be compared, so counts as
 * dearer.
 */
export function cheaperOrSame(from: Stripe.Price, to: Stripe.Price): boolean {
  return (
    flat(from) &&
    flat(to) &&
    from.currency === to.currency &&
    from.recurring?.interval === to.recurring?.interval &&
    from.recurring?.interval_count === to.recurring?.interval_count &&
    (to.unit_amount ?? Number.POSITIVE_INFINITY) <=
      (from.unit_amount ?? Number.NEGATIVE_INFINITY)
  );
}

const discounted = (ch: Change) =>
  ch.sub.discounts.length > 0 || ch.item.discounts.length > 0;

const moving = (ctx: Ctx, ch: Change) =>
  `${tag(ctx)} Move ${who(ch.c)}'s subscription (${ch.sub.id}) from ${priceLabel(ch.item.price)} to ${priceLabel(ch.to)}`;

function atRenewal(ctx: Ctx, ch: Change): JobPlan {
  const { end } = period(ch.sub);
  const undoWindow = undoWindowBefore(ctx, end);
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
    ...(undoWindow === undefined ? {} : { undoWindow }),
    data: { confirm: confirmPhrase(ch.c) },
    apply: () =>
      changeAtRenewal(ctx, {
        subscription: ch.sub.id,
        price: ch.to,
        quantity: ch.quantity,
      }),
  };
}

/**
 * What "now" is previewed as: `total` is the proration's net (positive is a charge, negative a
 * credit), and `amount_due` what's charged after the customer's credit balance.
 */
type Preview = Pick<Stripe.Invoice, 'total' | 'amount_due' | 'currency'>;

/** A prorated charge: what's due after the customer's balance, which is what's charged. */
function charge(p: Preview, from: string) {
  const net = formatMoney(p.total, p.currency);
  const due = formatMoney(p.amount_due, p.currency);
  const says =
    p.amount_due === p.total
      ? `Stripe charges ${due} today`
      : p.amount_due > 0
        ? `Stripe charges ${due} today (${net}, less their credit balance)`
        : `${net}, paid from their credit balance`;

  return {
    says: `${says} (prorated)`,
    effect: create(
      'invoice',
      `${net} prorated, ${due} charged today; if the payment fails, the subscription stays on ${from}`,
    ),
    uses: undefined,
  };
}

/** What "now" charges or credits, in words and as `spend` (only a credit leaves the business). */
function proration(p: Preview, from: string) {
  if (p.total > 0) {
    return charge(p, from);
  }

  if (p.total < 0) {
    const money = formatMoney(-p.total, p.currency);

    return {
      says: `${money} goes to their Stripe credit balance (prorated)`,
      effect: create('credit', `${money} to the customer's balance`),
      uses: { spend: toQuantity(-p.total, p.currency) },
    };
  }

  return { says: 'no charge (prorated)', effect: null, uses: undefined };
}

async function nowProrated(ctx: Ctx, ch: Change): Promise<JobPlan> {
  const date = Math.max(startOfDay(ctx.now()), period(ch.sub).start);
  const items = [{ id: ch.item.id, price: ch.to.id, quantity: ch.quantity }];
  const preview = await ctx.stripe.read((s) =>
    s.invoices.createPreview({
      subscription: ch.sub.id,
      subscription_details: {
        items,
        proration_behavior: 'always_invoice',
        proration_date: date,
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
        `prorated from ${day(date)}`,
      ),
      ...(p.effect ? [p.effect] : []),
    ],
    ...(p.uses ? { uses: p.uses } : {}),
    risk: riskFor(ctx, 'medium'),
    data: { confirm: confirmPhrase(ch.c) },
    apply: () =>
      applying(async () => {
        // A declined payment leaves the update pending, not the new price on an unpaid invoice.
        const sub = await ctx.stripe.write((s, o) =>
          s.subscriptions.update(
            ch.sub.id,
            {
              items,
              proration_behavior: 'always_invoice',
              proration_date: date,
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
      }),
  };
}

/**
 * Which plans a subscription can have. With a schedule: never "at renewal" (releasing would drop
 * phases we didn't make), and "now" only when nothing else is pending, since a later phase
 * would undo it.
 */
async function whatFits(ctx: Ctx, ch: Change) {
  const ends = ch.sub.cancel_at_period_end || ch.sub.cancel_at !== null;

  if (!ch.sub.schedule) {
    return {
      renewal: !ends && !discounted(ch) && uncopied(ch.sub).length === 0,
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

async function changePlans(ctx: Ctx, input: ChangeInput) {
  const c = await oneCustomer(ctx, input);

  if ('clarify' in c) {
    return c.clarify;
  }

  const sub = await oneSubscription(ctx, c.found, input);

  if ('clarify' in sub) {
    return sub.clarify;
  }

  refusePending(sub.found);

  const item = oneItem(sub.found);
  const to = await findPrice(ctx, input.price);

  refuseUnsafe(item.price, to);

  const ch: Change = {
    c: c.found,
    sub: sub.found,
    item,
    to,
    quantity: item.quantity ?? 1,
  };
  const fits = await whatFits(ctx, ch);
  const plans = fits.renewal ? [atRenewal(ctx, ch)] : [];

  plans.push(await nowProrated(ctx, ch));

  return plans;
}

/** Undo "at renewal": release the schedule `apply()` created. */
async function revertChange(ctx: Ctx, result: unknown) {
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

export function changeJob(ctx: Ctx): JobSpec<ChangeInput> {
  return {
    name: 'change_plan',
    title: 'Change a subscription plan',
    description:
      "Move a customer's subscription to another price, for the Stripe API: at renewal (undoable until a day before it), or now with proration (charges or credits at once; not undoable). The user approves by typing the customer's email.",
    schema: SCHEMA,
    risk: riskFor(ctx, 'medium'),
    plan: (input) => changePlans(ctx, input),
    revert: (_input, result) => revertChange(ctx, result),
  };
}
