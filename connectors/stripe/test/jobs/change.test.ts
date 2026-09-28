import { describe, expect, it } from 'vitest';
import type { Stripe } from '../../src/api.js';
import { cheaperOrSame } from '../../src/jobs/change/prices.js';
import { changeJob } from '../../src/jobs/change.js';
import { parseForm, price } from '../fake-stripe.js';
import { D, expectOwnFreshKeys, NOW, plansOf, setup } from '../helpers.js';

const toBasic = { customer: 'Chen', price: 'price_basic' };
const today = NOW - 10 * 3600;

describe('change_plan plans', () => {
  it('a cheaper price: at renewal (low, undoable) first, then now, which credits and so spends', async () => {
    const s = setup();
    const [renewal, now] = await plansOf(changeJob(s.ctx), toBasic);

    expect(renewal).toMatchObject({
      summary:
        '[test] Move "Chen Wei"\'s subscription (sub_chen) from pro (49.00 USD/month) to basic (19.00 USD/month) at renewal, 2026-10-11',
      effects: [
        {
          op: 'create',
          target: 'subscription_schedule',
          detail: 'for sub_chen: pro until 2026-10-11, then basic × 1',
        },
      ],
      risk: 'low',
      undoWindow: 13 * D,
      data: { confirm: 'chen@wei.studio' },
    });
    expect(renewal.uses).toBeUndefined();
    // Stripe's preview: 19.00 − 49.00 USD for 14 days 10 hours of 30.
    expect(now).toMatchObject({
      summary:
        '[test] Move "Chen Wei"\'s subscription (sub_chen) from pro (49.00 USD/month) to basic (19.00 USD/month) now; 14.42 USD goes to their Stripe credit balance (prorated)',
      effects: [
        {
          op: 'update',
          target: 'subscription/sub_chen',
          field: 'price',
          from: 'price_pro',
          to: 'price_basic',
          detail: 'prorated from 2026-09-27',
        },
        {
          op: 'create',
          target: 'credit',
          detail: "14.42 USD to the customer's balance",
        },
      ],
      uses: { spend: { amount: 1442, scale: 2, unit: 'USD' } },
      risk: 'medium',
    });
    expect(now.undoWindow).toBeUndefined();
  });

  it('plans with reads and the invoice preview only, at a proration date of the start of today', async () => {
    const s = setup();

    await plansOf(changeJob(s.ctx), toBasic);
    expect(s.stripe.writes()).toEqual([]);

    const preview = s.stripe.calls.find(
      (c) => c.path === '/v1/invoices/create_preview',
    );

    expect(parseForm(preview?.body ?? '')).toEqual({
      subscription: 'sub_chen',
      subscription_details: {
        items: [{ id: 'si_chen', price: 'price_basic', quantity: '1' }],
        proration_behavior: 'always_invoice',
        proration_date: String(today),
      },
    });
  });

  it('now sends the previewed proration date, so the charge is the one approved', async () => {
    const s = setup();
    const [, now] = await plansOf(changeJob(s.ctx), {
      ...toBasic,
      price: 'team',
    });

    expect(now.summary).toMatch(
      /now; Stripe charges 24.03 USD today \(prorated\)$/,
    );
    expect(now.uses).toBeUndefined();
    expect(await now.apply()).toEqual({
      plan: 'change_now',
      subscription: 'sub_chen',
      price: 'price_team',
    });

    const [w] = s.stripe.writes();

    expect(w.path).toBe('/v1/subscriptions/sub_chen');
    expect(parseForm(w.body)).toEqual({
      items: [{ id: 'si_chen', price: 'price_team', quantity: '1' }],
      proration_behavior: 'always_invoice',
      proration_date: String(today),
      payment_behavior: 'pending_if_incomplete',
    });
    expectOwnFreshKeys(s.stripe);
    expect(s.stripe.state.prorations).toEqual([
      { subscription: 'sub_chen', at: today, total: 2403 },
    ]);
  });

  it('the proration date is never before the period started', async () => {
    const s = setup();

    s.stripe.subs[0].items.data[0].current_period_start = NOW - 3600;

    const [, now] = await plansOf(changeJob(s.ctx), toBasic);

    expect(now.effects[0].detail).toBe('prorated from 2026-09-27');

    const preview = s.stripe.calls.find((c) =>
      c.path.includes('create_preview'),
    );

    expect(parseForm(preview?.body ?? '')).toMatchObject({
      subscription_details: { proration_date: String(NOW - 3600) },
    });
  });

  it('at renewal is two writes: a schedule from the subscription, then its phases', async () => {
    const s = setup();
    const job = changeJob(s.ctx);
    const [renewal] = await plansOf(job, toBasic);
    const result = await renewal.apply();

    expect(result).toEqual({
      plan: 'change_at_renewal',
      schedule: 'sub_sched_1',
      subscription: 'sub_chen',
      price: 'price_basic',
    });

    const [made, phased] = s.stripe.writes();
    const item = s.stripe.subs[0].items.data[0];

    expect([made.path, made.body]).toEqual([
      '/v1/subscription_schedules',
      'from_subscription=sub_chen',
    ]);
    expect(phased.path).toBe('/v1/subscription_schedules/sub_sched_1');
    expect(parseForm(phased.body)).toEqual({
      end_behavior: 'release',
      phases: [
        {
          collection_method: 'charge_automatically',
          currency: 'usd',
          start_date: String(item.current_period_start),
          end_date: String(item.current_period_end),
          items: [{ price: 'price_pro', quantity: '1' }],
        },
        {
          collection_method: 'charge_automatically',
          currency: 'usd',
          items: [{ price: 'price_basic', quantity: '1' }],
          duration: { interval: 'month', interval_count: '1' },
          proration_behavior: 'none',
        },
      ],
      metadata: { created_by: 'yea-stripe' },
    });
    expect(made.key).not.toBe(phased.key);
    expect(s.stripe.subs[0].schedule).toBe('sub_sched_1');

    // Undo releases the schedule it made: the subscription stays, the pending phase goes.
    await job.revert?.(toBasic, result);
    expect(s.stripe.writes().at(-1)?.path).toBe(
      '/v1/subscription_schedules/sub_sched_1/release',
    );
    expect(s.stripe.subs[0].schedule).toBeNull();
    expect(s.stripe.subs[0].items.data[0].price.id).toBe('price_pro');
    expectOwnFreshKeys(s.stripe);
  });

  it('a failed second write releases the schedule, and says nothing changed', async () => {
    const s = setup();
    const [renewal] = await plansOf(changeJob(s.ctx), toBasic);

    s.stripe.fail({
      path: '/subscription_schedules/sub_sched_1',
      status: 400,
      message: 'bad phase',
    });

    const e = (await Promise.resolve(renewal.apply()).catch(
      (x: unknown) => x,
    )) as Error & {
      partial?: boolean;
    };

    expect(e.partial).toBeUndefined();
    expect(e.message).toBe(
      'adding the new phase failed (Stripe: bad phase); schedule sub_sched_1 was released, so the subscription is as it was',
    );
    expect(s.stripe.writes().at(-1)?.path).toBe(
      '/v1/subscription_schedules/sub_sched_1/release',
    );
    expect(s.stripe.subs[0].schedule).toBeNull();
    expectOwnFreshKeys(s.stripe);
  });

  it('a second write with no answer is released too', async () => {
    const s = setup();
    const [renewal] = await plansOf(changeJob(s.ctx), toBasic);

    s.stripe.fail({
      path: '/subscription_schedules/sub_sched_1',
      network: true,
      times: 3,
    });
    await expect(Promise.resolve(renewal.apply())).rejects.toThrow(
      /was released/,
    );
    expect(s.stripe.state.schedules[0].status).toBe('released');
  });

  it('a failed release names the leftover schedule, and is a part-way failure', async () => {
    const s = setup();
    const [renewal] = await plansOf(changeJob(s.ctx), toBasic);

    s.stripe.fail({
      path: '/subscription_schedules/sub_sched_1',
      status: 400,
      message: 'bad phase',
    });
    s.stripe.fail({
      path: '/subscription_schedules/sub_sched_1/release',
      status: 500,
      times: 3,
    });

    const e = (await Promise.resolve(renewal.apply()).catch(
      (x: unknown) => x,
    )) as Error & {
      partial?: boolean;
    };

    expect(e.partial).toBe(true);
    expect(e.message).toMatch(
      /^adding the new phase failed \(Stripe: bad phase\), and releasing schedule sub_sched_1 failed too \(.*\)\. sub_chen is left on subscription schedule sub_sched_1: release it in the Stripe dashboard, or with POST \/v1\/subscription_schedules\/sub_sched_1\/release\.$/,
    );
  });

  it('a first write with no answer may have left a schedule, and says so', async () => {
    const s = setup();
    const [renewal] = await plansOf(changeJob(s.ctx), toBasic);

    s.stripe.fail({ path: '/subscription_schedules', network: true, times: 3 });

    const e = (await Promise.resolve(renewal.apply()).catch(
      (x: unknown) => x,
    )) as Error & {
      partial?: boolean;
    };

    expect(e.partial).toBe(true);
    expect(e.message).toMatch(/may have happened/);
  });

  it('a dearer price, or one that can’t be compared, is medium at renewal', async () => {
    for (const p of ['price_team', 'price_metered', 'price_tiered']) {
      const s = setup();
      const [renewal] = await plansOf(changeJob(s.ctx), {
        customer: 'Chen',
        price: p,
      });

      expect([p, renewal.risk]).toEqual([p, 'medium']);
    }
  });

  it.each([
    [
      'price_pro_yearly',
      /bills every 1 year, and the subscription every 1 month; changing the billing interval isn't supported yet/,
    ],
    ['price_eur', /is in EUR, and the subscription is in USD/],
    ['price_pro', /already on pro/],
    ['nope', /no single active price has lookup key "nope"/],
  ])('refuses %s', async (p, why) => {
    const s = setup();

    await expect(
      changeJob(s.ctx).plan({ customer: 'Chen', price: p }),
    ).rejects.toThrow(why);
    expect(s.stripe.writes()).toEqual([]);
  });

  it('refuses a subscription with more than one item', async () => {
    const s = setup();
    const item = s.stripe.subs[0].items.data[0];

    s.stripe.subs[0].items.data.push({
      ...item,
      id: 'si_2',
      price: price('price_addon', 500),
    });
    await expect(changeJob(s.ctx).plan(toBasic)).rejects.toThrow(
      /more than one item/,
    );
  });

  it('a discount, or a cancellation pending, leaves only "now"', async () => {
    const s = setup();

    s.stripe.subs[0].discounts = ['di_1'];
    expect(
      (await plansOf(changeJob(s.ctx), toBasic)).map((p) => p.risk),
    ).toEqual(['medium']);

    s.stripe.subs[0].discounts = [];
    s.stripe.subs[0].cancel_at_period_end = true;
    expect(await plansOf(changeJob(s.ctx), toBasic)).toHaveLength(1);
  });

  it('a schedule we didn’t make: never at renewal; now only when nothing else is pending', async () => {
    const s = setup();
    const [renewal] = await plansOf(changeJob(s.ctx), toBasic);

    await renewal.apply();

    // sub_chen now has a schedule with a pending phase.
    await expect(changeJob(s.ctx).plan(toBasic)).rejects.toThrow(
      /sub_chen has changes pending on subscription schedule sub_sched_1/,
    );

    const sched = s.stripe.state.schedules[0];

    sched.phases = sched.phases.slice(0, 1);
    expect(
      (await plansOf(changeJob(s.ctx), toBasic)).map((p) => p.summary),
    ).toEqual([expect.stringMatching(/ now; /)]);
  });

  it('refuses to undo anything but at renewal', async () => {
    const s = setup();

    for (const bad of [
      { plan: 'change_now' },
      { plan: 'change_at_renewal', schedule: 'sub_x/y' },
    ]) {
      await expect(changeJob(s.ctx).revert?.(toBasic, bad)).rejects.toThrow(
        /can't be undone/,
      );
    }
  });
});

describe('change_plan, what the customer pays and what can be copied', () => {
  const toTeam = { customer: 'Chen', price: 'price_team' };

  it('shows what is charged after the customer’s credit balance', async () => {
    const s = setup({
      state: (b) => ({
        customers: b.customers.map((c) =>
          c.id === 'cus_chen' ? { ...c, balance: -1000 } : c,
        ),
      }),
    });
    const [, now] = await plansOf(changeJob(s.ctx), toTeam);

    expect(now.summary).toMatch(
      /now; Stripe charges 14.03 USD today \(24.03 USD, less their credit balance\) \(prorated\)$/,
    );
    expect(now.effects[1]).toEqual({
      op: 'create',
      target: 'invoice',
      detail:
        '24.03 USD prorated, 14.03 USD charged today; if the payment fails, the subscription stays on pro',
    });
  });

  it('a charge the balance covers says so', async () => {
    const s = setup({
      state: (b) => ({
        customers: b.customers.map((c) =>
          c.id === 'cus_chen' ? { ...c, balance: -5000 } : c,
        ),
      }),
    });
    const [, now] = await plansOf(changeJob(s.ctx), toTeam);

    expect(now.summary).toMatch(
      /now; 24.03 USD, paid from their credit balance \(prorated\)$/,
    );
  });

  it('a declined payment leaves the change pending and the old price on, and says so', async () => {
    const s = setup({ declines: true });
    const [, now] = await plansOf(changeJob(s.ctx), toTeam);
    const e = (await Promise.resolve(now.apply()).catch(
      (x: unknown) => x,
    )) as Error & { partial?: boolean };

    // Not a success: never "✓ … charges X today" as if paid.
    expect(e.partial).toBe(true);
    expect(e.message).toBe(
      "Stripe invoiced the change, but the payment didn't go through, so the change is pending, not made. If the invoice isn't paid within about 23 hours, Stripe discards the change and sub_chen stays on pro.",
    );
    expect(s.stripe.subs[0].items.data[0].price.id).toBe('price_pro');
  });

  it('after a change left pending, a retry offers neither "now" nor "at renewal", naming the invoice', async () => {
    const s = setup({ declines: true });
    const [, now] = await plansOf(changeJob(s.ctx), toTeam);

    await Promise.resolve(now.apply()).catch(() => null);
    expect(s.stripe.state.prorations).toHaveLength(1);

    for (const input of [toTeam, toBasic]) {
      await expect(changeJob(s.ctx).plan(input)).rejects.toThrow(
        "sub_chen already has a price change waiting on payment of in_1. Stripe applies it once that invoice is paid, or discards it if it isn't, by 2026-09-28 09:00 UTC; nothing else can change the plan until then",
      );
    }

    // No second update, no second invoice.
    expect(s.stripe.state.prorations).toHaveLength(1);
    expect(s.stripe.writes()).toHaveLength(1);
  });

  it('a pending update without a known invoice still refuses', async () => {
    const s = setup();

    s.stripe.subs[0].pending_update = {};
    await expect(changeJob(s.ctx).plan(toBasic)).rejects.toThrow(
      /waiting on payment of its open invoice\. Stripe applies it once that invoice is paid, or discards it if it isn't;/,
    );
  });

  it.each([
    ['by id', 'price_basic'],
    ['by lookup key', 'basic'],
  ])('refuses an inactive price %s', async (_how, ref) => {
    const s = setup();

    s.stripe.state.prices[1].active = false;
    await expect(
      changeJob(s.ctx).plan({ customer: 'Chen', price: ref }),
    ).rejects.toThrow(/isn't an active price|no single active price/);
  });

  it.each([
    ['automatic_tax', { enabled: true }],
    [
      'invoice_settings',
      { account_tax_ids: ['txi_1'], issuer: { type: 'self' } },
    ],
    [
      'invoice_settings',
      { account_tax_ids: null, issuer: { type: 'account' } },
    ],
    ['billing_thresholds', { amount_gte: 10000 }],
    ['on_behalf_of', 'acct_1'],
    ['transfer_data', { destination: 'acct_1' }],
    ['application_fee_percent', 5],
  ])('a subscription with %s set gets no "at renewal"', async (k, v) => {
    const s = setup();

    Object.assign(s.stripe.subs[0], { [k]: v });

    const plans = await plansOf(changeJob(s.ctx), toBasic);

    expect(plans.map((p) => p.summary)).toEqual([
      expect.stringMatching(/ now; /),
    ]);
  });

  it('defaults don’t count as set', async () => {
    const s = setup();

    Object.assign(s.stripe.subs[0], {
      automatic_tax: { enabled: false },
      invoice_settings: { account_tax_ids: null, issuer: { type: 'self' } },
      billing_thresholds: null,
      add_invoice_items: [],
    });
    expect(await plansOf(changeJob(s.ctx), toBasic)).toHaveLength(2);
  });

  it('a schedule whose phase carries a setting the copy would drop is released, and nothing changes', async () => {
    const s = setup();
    const [renewal] = await plansOf(changeJob(s.ctx), toBasic);

    // Stripe puts something on the phase it makes that the subscription didn't show.
    s.stripe.onSchedule((sched) => {
      Object.assign(sched.phases[0], {
        add_invoice_items: [{ price: 'price_setup' }],
      });
    });
    await expect(Promise.resolve(renewal.apply())).rejects.toThrow(
      /its current phase has add_invoice_items, which a change at renewal can't copy yet\); schedule sub_sched_1 was released/,
    );
    expect(s.stripe.state.schedules[0].status).toBe('released');
    expect(s.stripe.writes().map((w) => w.path)).toEqual([
      '/v1/subscription_schedules',
      '/v1/subscription_schedules/sub_sched_1/release',
    ]);
  });
});

describe('cheaper or same', () => {
  // The fake's prices carry only the fields the connector reads.
  const compare = (a: object, b: object) =>
    cheaperOrSame(a as Stripe.Price, b as Stripe.Price);
  const base = price('price_a', 1000);

  it('is flat per-unit prices in the same currency and interval, no dearer', () => {
    expect(compare(base, price('price_b', 1000))).toBe(true);
    expect(compare(base, price('price_b', 999))).toBe(true);
    expect(compare(base, price('price_b', 1001))).toBe(false);
  });

  it('anything not comparable counts as dearer', () => {
    for (const b of [
      price('price_b', 500, { currency: 'eur' }),
      price('price_b', 500, { interval: 'year' }),
      price('price_b', 500, { usage_type: 'metered' }),
      price('price_b', null, { billing_scheme: 'tiered' }),
      price('price_b', 500, { transform_quantity: { divide_by: 10 } }),
      price('price_b', 500, { billing_scheme: undefined }),
    ]) {
      expect(compare(base, b)).toBe(false);
    }

    expect(
      compare(price('price_a', null, { billing_scheme: 'tiered' }), base),
    ).toBe(false);
  });
});
