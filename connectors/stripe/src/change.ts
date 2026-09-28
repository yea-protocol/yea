/**
 * `change_plan`: at renewal (a schedule, undoable until a day before it) or now, prorated (not
 * undoable). "Now" is previewed with `create_preview` at a proration date fixed to the start of
 * today, and the update sends that same date, so the charge is the one the person approved.
 */
import { create, type JobPlan, type Risk, update } from '@yea-protocol/sdk';
import {
  type Customer,
  type Price,
  period,
  type Subscription,
  type SubscriptionItem,
} from './api.js';
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
  c: Customer;
  sub: Subscription;
  item: SubscriptionItem;
  to: Price;
  quantity: number;
}

/** The price asked for: by id, or by lookup key among active prices. */
async function findPrice(ctx: Ctx, ref: string): Promise<Price> {
  if (/^price_[A-Za-z0-9_]+$/.test(ref)) {
    return ctx.stripe.get<Price>(`/prices/${ref}`);
  }

  const found = await ctx.stripe.get<{ data: Price[] }>('/prices', {
    'lookup_keys[0]': ref,
    active: 'true',
  });
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
function refuseUnsafe(from: Price, to: Price) {
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

  const every = (p: Price) =>
    `${p.recurring?.interval_count ?? 1} ${p.recurring?.interval ?? '?'}`;

  if (every(from) !== every(to)) {
    throw new Error(
      `${priceLabel(to)} bills every ${every(to)}, and the subscription every ${every(from)}; changing the billing interval isn't supported yet, because Stripe resets the billing date and charges at once`,
    );
  }
}

/** Flat per-unit pricing: the only kind whose prices can be compared. */
const flat = (p: Price) =>
  p.billing_scheme === 'per_unit' &&
  p.recurring?.usage_type === 'licensed' &&
  typeof p.unit_amount === 'number' &&
  (p.transform_quantity ?? null) === null;

/**
 * Cheaper or the same: both flat per-unit, in the same currency and interval, with the same
 * quantity, and the new unit amount no higher. Anything else can't be compared, so counts as
 * dearer.
 */
export function cheaperOrSame(from: Price, to: Price): boolean {
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
  (ch.sub.discounts?.length ?? 0) > 0 || (ch.item.discounts?.length ?? 0) > 0;

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

interface Preview {
  total: number;
  currency: string;
}

/** What "now" charges or credits, in words and as `spend` (only a credit leaves the business). */
function proration(net: number, cur: string) {
  const money = formatMoney(Math.abs(net), cur);

  if (net > 0) {
    return {
      says: `Stripe charges ${money} today (prorated)`,
      effect: create('invoice', `${money}, charged today`),
      uses: undefined,
    };
  }

  if (net < 0) {
    return {
      says: `${money} goes to their Stripe credit balance (prorated)`,
      effect: create('credit', `${money} to the customer's balance`),
      uses: { spend: toQuantity(-net, cur) },
    };
  }

  return { says: 'no charge (prorated)', effect: null, uses: undefined };
}

async function nowProrated(ctx: Ctx, ch: Change): Promise<JobPlan> {
  const date = Math.max(startOfDay(ctx.now()), period(ch.sub).start);
  const items = [{ id: ch.item.id, price: ch.to.id, quantity: ch.quantity }];
  const preview = await ctx.stripe.preview<Preview>(
    '/invoices/create_preview',
    {
      subscription: ch.sub.id,
      subscription_details: {
        items,
        proration_behavior: 'always_invoice',
        proration_date: date,
      },
    },
  );
  const p = proration(preview.total, preview.currency);

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
        await ctx.stripe.write('POST', `/subscriptions/${ch.sub.id}`, {
          items,
          proration_behavior: 'always_invoice',
          proration_date: date,
        });

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
  const ends =
    ch.sub.cancel_at_period_end || (ch.sub.cancel_at ?? null) !== null;

  if (!ch.sub.schedule) {
    return { renewal: !ends && !discounted(ch), now: true };
  }

  const s = await getSchedule(ctx, ch.sub.schedule);

  if (!onlyCurrentPhase(s, period(ch.sub).end)) {
    throw new Error(
      `${ch.sub.id} has changes pending on subscription schedule ${s.id}; undo that change or edit the schedule in the Stripe dashboard first`,
    );
  }

  return { renewal: false, now: true };
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

  return releaseSchedule(ctx, r.schedule);
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
