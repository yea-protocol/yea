/**
 * Against real Stripe test mode, only when STRIPE_TEST_KEY is set; skipped otherwise, and never
 * run in CI. It confirms the pinned API version is accepted and the read permissions
 * (customers, charges, subscriptions, prices, the invoice preview). With STRIPE_TEST_WRITES=1
 * it also cancels at period end and changes a plan at renewal, then undoes both, which
 * confirms the write permissions, subscription schedules included. Test mode costs nothing.
 *
 * It also checks what the build couldn't confirm from Stripe's docs:
 * - an `always_invoice` preview holds proration lines only;
 * - Stripe answers with `livemode: false` for a test key;
 * - a subscription with settings the phase copy drops (automatic tax, invoice settings…) is
 *   offered no "at renewal";
 * - by hand, for now: `payment_behavior=pending_if_incomplete` with a declining test card
 *   (4000 0000 0000 0341) leaves the old price on, and `DELETE` on a scheduled subscription
 *   cancels it (the fake allows it).
 *
 *   STRIPE_TEST_KEY=rk_test_… STRIPE_TEST_CUSTOMER=cus_… STRIPE_TEST_PRICE=price_… \
 *     [STRIPE_TEST_WRITES=1] npx vitest run test/smoke.test.ts
 */
import { describe, expect, it } from 'vitest';
import { isLiveKey, type Subscription } from '../src/api.js';
import { cancelJob } from '../src/cancel.js';
import { changeJob } from '../src/change.js';
import { refundJob } from '../src/refund.js';
import { uncopied } from '../src/schedule.js';
import { contextFor } from '../src/server.js';

const key = process.env.STRIPE_TEST_KEY ?? '';
const customer = process.env.STRIPE_TEST_CUSTOMER ?? '';
const price = process.env.STRIPE_TEST_PRICE ?? '';

describe.skipIf(!key)('real Stripe, test mode', () => {
  const ctx = contextFor({ key });

  it('is a test key', () => {
    expect(isLiveKey(key)).toBe(false);
  });

  it.skipIf(!customer || !price)(
    'an always_invoice preview holds proration lines only',
    async () => {
      const subs = await ctx.stripe.get<{ data: Subscription[] }>(
        '/subscriptions',
        { customer, limit: '1' },
      );
      const sub = subs.data[0];
      const item = sub?.items.data[0];

      expect(item).toBeDefined();

      const preview = await ctx.stripe.preview<{
        lines: {
          data: {
            proration?: boolean;
            parent?: { subscription_item_details?: { proration?: boolean } };
          }[];
        };
      }>('/invoices/create_preview', {
        subscription: sub?.id,
        subscription_details: {
          items: [{ id: item?.id, price, quantity: item?.quantity ?? 1 }],
          proration_behavior: 'always_invoice',
          proration_date: Math.floor(Date.now() / 1000),
        },
      });

      expect(
        preview.lines.data.every(
          (l) =>
            l.parent?.subscription_item_details?.proration === true ||
            l.proration === true,
        ),
      ).toBe(true);
    },
  );

  it.skipIf(!customer || !price)(
    'a subscription with settings the copy drops gets no "at renewal"',
    async () => {
      const subs = await ctx.stripe.get<{ data: Subscription[] }>(
        '/subscriptions',
        { customer, limit: '1' },
      );
      const plans = await changeJob(ctx).plan({ customer, price });

      if (
        Array.isArray(plans) &&
        subs.data[0] &&
        uncopied(subs.data[0]).length
      ) {
        expect(plans.some((p) => p.summary.includes('at renewal'))).toBe(false);
      }
    },
  );

  it.skipIf(!customer)(
    'plans each job with reads and the preview only',
    async () => {
      const refund = await refundJob(ctx).plan({ customer });
      const cancel = await cancelJob(ctx).plan({ customer });

      expect(Array.isArray(refund) || 'clarify' in refund).toBe(true);
      expect(Array.isArray(cancel)).toBe(true);

      if (price) {
        expect(
          Array.isArray(await changeJob(ctx).plan({ customer, price })),
        ).toBe(true);
      }
    },
  );

  it.skipIf(!customer || !price || process.env.STRIPE_TEST_WRITES !== '1')(
    'cancels at period end and changes at renewal, then undoes both',
    async () => {
      const cancel = cancelJob(ctx);
      const [atEnd] = (await cancel.plan({ customer })) as {
        apply(): unknown;
      }[];
      const cancelled = await atEnd.apply();

      await cancel.revert?.({ customer }, cancelled);

      const change = changeJob(ctx);
      const [renewal] = (await change.plan({ customer, price })) as {
        summary: string;
        apply(): unknown;
      }[];

      expect(renewal.summary).toContain('at renewal');

      const changed = await renewal.apply();

      await change.revert?.({ customer, price }, changed);
    },
  );
});
