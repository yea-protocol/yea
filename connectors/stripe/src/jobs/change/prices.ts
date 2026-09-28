/**
 * The price a plan change moves to: found by id or lookup key, refused when v0 can't move to it
 * safely, and compared with the current one to set the change's risk.
 */
import type { Stripe } from '../../api.js';
import type { Ctx } from '../../context.js';
import { priceLabel } from '../../find.js';
import { quoted } from '../../text.js';

/** The price asked for: by id, or by lookup key among active prices. */
export async function findPrice(ctx: Ctx, ref: string): Promise<Stripe.Price> {
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
export function refuseUnsafe(from: Stripe.Price, to: Stripe.Price) {
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
