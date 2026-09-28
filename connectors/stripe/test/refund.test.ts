import type { Clarification } from '@yea-protocol/sdk';
import { describe, expect, it } from 'vitest';
import { refundJob } from '../src/refund.js';
import { customersNamed } from './fixtures.js';
import { D, NOW, plansOf, setup } from './helpers.js';

const chen = { customer: 'Chen' };

describe('refund plans', () => {
  it('offers all of the latest payment, and what is unused of the period it paid for', async () => {
    const s = setup();
    const plans = await plansOf(refundJob(s.ctx), chen);

    expect(plans.map((p) => p.summary)).toEqual([
      '[test] Refund 49.00 USD of ch_2 (paid 2026-09-11) to "Chen Wei" (all of it)',
      // 14 days 10 hours of 30 are left, from the start of today: 4900 × 1245600 / 2592000.
      '[test] Refund 23.54 USD of ch_2 (paid 2026-09-11) to "Chen Wei" (estimated unused 15 days of the current period)',
    ]);
    expect(plans[0]).toMatchObject({
      effects: [
        {
          op: 'create',
          target: 'refund',
          detail:
            "49.00 USD back to the payment method of ch_2; Stripe can't reverse it",
        },
        {
          op: 'update',
          target: 'charge/ch_2',
          field: 'amount_refunded',
          from: '0.00 USD',
          to: '49.00 USD',
        },
      ],
      uses: { spend: { amount: 4900, scale: 2, unit: 'USD' } },
      risk: 'medium',
      data: { confirm: '49.00' },
    });
    expect(plans[1].uses).toEqual({
      spend: { amount: 2354, scale: 2, unit: 'USD' },
    });
    expect(plans.every((p) => p.undoWindow === undefined)).toBe(true);
  });

  it('plans with reads only, and a refund is one POST with payment_intent and amount', async () => {
    const s = setup();
    const plans = await plansOf(refundJob(s.ctx), chen);

    expect(s.stripe.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(s.stripe.writes()).toEqual([]);

    const result = await plans[1].apply();

    expect(s.stripe.writes().map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/v1/refunds', 'payment_intent=pi_2&amount=2354'],
    ]);
    expect(result).toEqual({
      plan: 'refund',
      refund: 're_1',
      status: 'succeeded',
      charge: 'ch_2',
      amount: '23.54 USD',
    });
  });

  it('a payment without a payment intent is refunded by charge', async () => {
    const s = setup({
      state: (b) => ({
        charges: b.charges.map((c) => ({ ...c, payment_intent: null })),
      }),
    });
    const [full] = await plansOf(refundJob(s.ctx), chen);

    await full.apply();
    expect(s.stripe.writes()[0].body).toBe('charge=ch_2&amount=4900');
  });

  it('an amount, as a string, is one partial plan', async () => {
    const s = setup();
    const plans = await plansOf(refundJob(s.ctx), { ...chen, amount: '10' });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      summary:
        '[test] Refund 10.00 USD of ch_2 (paid 2026-09-11) to "Chen Wei" (partial)',
      data: { confirm: '10.00' },
    });
  });

  it.each([
    ['0', /more than 0 and at most 49.00 USD/],
    ['49.01', /more than 0 and at most 49.00 USD, what's left of ch_2/],
    ['10.005', /at most 2 decimals/],
    ['ten', /decimal number/],
  ])('refuses the amount %s', async (amount, why) => {
    const s = setup();

    await expect(refundJob(s.ctx).plan({ ...chen, amount })).rejects.toThrow(
      why,
    );
    expect(s.stripe.writes()).toEqual([]);
  });

  it('an older payment, by ch_ or pi_ id, is offered in full only', async () => {
    const s = setup();

    for (const payment of ['ch_1', 'pi_1']) {
      const plans = await plansOf(refundJob(s.ctx), { ...chen, payment });

      expect(plans.map((p) => p.summary)).toEqual([
        '[test] Refund 49.00 USD of ch_1 (paid 2026-08-12) to "Chen Wei" (all of it)',
      ]);
    }
  });

  it('a payment that isn’t theirs, or didn’t succeed, is refused with their recent payments', async () => {
    const s = setup();

    await expect(
      refundJob(s.ctx).plan({ ...chen, payment: 'ch_nope' }),
    ).rejects.toThrow(
      /"ch_nope" isn't one of "Chen Wei"'s recent payments that succeeded. Recent payments: ch_2 \(2026-09-11, 49.00 USD, 49.00 USD left, succeeded\); ch_1/,
    );
  });

  it('a fully refunded payment is refused, naming the refunds already made, never moved to an older one', async () => {
    const s = setup();
    const [full] = await plansOf(refundJob(s.ctx), chen);

    await full.apply();
    await expect(refundJob(s.ctx).plan(chen)).rejects.toThrow(
      /^"Chen Wei"'s payment ch_2 \(2026-09-11\) is fully refunded, by re_1 \(49.00 USD, 2026-09-27, succeeded\); to refund an older payment, pass its id as payment. Recent payments: ch_2 .*; ch_1 \(2026-08-12, 49.00 USD, 49.00 USD left, succeeded\)$/,
    );
    await expect(
      refundJob(s.ctx).plan({ ...chen, payment: 'ch_2' }),
    ).rejects.toThrow(
      /^"Chen Wei"'s payment ch_2 \(2026-09-11\) is fully refunded, by re_1 \(49.00 USD, 2026-09-27, succeeded\)$/,
    );

    // Asked for by id, the older one is fine.
    expect(
      await plansOf(refundJob(s.ctx), { ...chen, payment: 'ch_1' }),
    ).toHaveLength(1);
  });

  it('the latest payment that failed is skipped for the latest that succeeded', async () => {
    const s = setup({
      state: (b) => ({
        charges: [
          {
            ...b.charges[0],
            id: 'ch_3',
            payment_intent: 'pi_3',
            status: 'failed',
            created: NOW - D,
          },
          ...b.charges,
        ],
      }),
    });
    const [full] = await plansOf(refundJob(s.ctx), chen);

    expect(full.summary).toContain('of ch_2 (paid 2026-09-11)');
  });

  /** The refund reaches Stripe, but every answer is lost: a part-way failure. */
  async function lost(s: ReturnType<typeof setup>, plan: { apply(): unknown }) {
    s.stripe.fail({ path: '/refunds', after: true, times: 3 });

    const e = (await Promise.resolve(plan.apply()).catch(
      (x: unknown) => x,
    )) as Error & { partial?: boolean };

    expect(e.partial).toBe(true);
  }

  it('a retry after an unused refund whose answer was lost says it was refunded, asks for "again", and offers no more unused', async () => {
    const s = setup();
    const [, unused] = await plansOf(refundJob(s.ctx), chen);

    await lost(s, unused);
    expect(s.stripe.charges[0].amount_refunded).toBe(2354);

    const again = await plansOf(refundJob(s.ctx), chen);

    // The unused share is of what was paid, less what's refunded: nothing more to offer.
    expect(again.map((p) => p.summary)).toEqual([
      '[test] Refund 25.46 USD of ch_2 (paid 2026-09-11; already refunded 23.54 USD on 2026-09-27) to "Chen Wei" (all of what\'s left)',
    ]);
    expect(again[0].data).toEqual({ confirm: '25.46 again' });
    expect(s.stripe.state.refunds).toHaveLength(1);
  });

  it('a retry after an explicit amount whose answer was lost says so, and asks for "again"', async () => {
    const s = setup();
    const input = { ...chen, amount: '10' };
    const [first] = await plansOf(refundJob(s.ctx), input);

    expect(first.data).toEqual({ confirm: '10.00' });
    await lost(s, first);

    const [again] = await plansOf(refundJob(s.ctx), input);

    expect(again.summary).toBe(
      '[test] Refund 10.00 USD of ch_2 (paid 2026-09-11; already refunded 10.00 USD on 2026-09-27) to "Chen Wei" (partial)',
    );
    expect(again.data).toEqual({ confirm: '10.00 again' });
  });

  it('asking again after part of the unused share was refunded offers only the rest of it', async () => {
    const s = setup();

    s.stripe.charges[0].amount_refunded = 1000;
    s.stripe.state.refunds.push({
      id: 're_0',
      amount: 1000,
      charge: 'ch_2',
      created: NOW - D,
      status: 'succeeded',
    });

    // A later refund that failed doesn't count as when it was refunded.
    s.stripe.state.refunds.push({
      id: 're_failed',
      amount: 500,
      charge: 'ch_2',
      created: NOW,
      status: 'failed',
    });

    const [full, unused] = await plansOf(refundJob(s.ctx), chen);

    expect(full.summary).toContain('already refunded 10.00 USD on 2026-09-26');
    // 23.54 of 49.00 paid is unused; 10.00 of it is already back.
    expect(unused.summary).toMatch(/^\[test\] Refund 13.54 USD of ch_2/);
    expect(unused.data).toEqual({ confirm: '13.54 again' });
  });

  it('no unused plan when the period has barely started, or the payment is older than it', async () => {
    const s = setup({
      state: (b) => ({
        charges: b.charges.map((c) =>
          c.id === 'ch_2' ? { ...c, created: NOW - 40 * D } : c,
        ),
      }),
    });

    expect(await plansOf(refundJob(s.ctx), chen)).toHaveLength(1);
  });

  it('a deliberate second identical refund writes twice, each with a fresh idempotency key', async () => {
    const s = setup();
    const input = { ...chen, amount: '10.00' };
    const [first] = await plansOf(refundJob(s.ctx), input);

    await first.apply();

    const [second] = await plansOf(refundJob(s.ctx), input);

    await second.apply();

    const writes = s.stripe.writes();

    expect(writes.map((w) => w.body)).toEqual([
      'payment_intent=pi_2&amount=1000',
      'payment_intent=pi_2&amount=1000',
    ]);
    expect(writes[0].key).not.toBe(writes[1].key);
    expect(s.stripe.charges[0].amount_refunded).toBe(2000);

    // Even the same plan applied twice (the approval core stops this) is two writes, not a replay.
    await second.apply();
    expect(new Set(s.stripe.writes().map((w) => w.key)).size).toBe(3);
  });

  it('a refund whose result is unknown fails part-way, never "nothing changed"', async () => {
    const s = setup();
    const [full] = await plansOf(refundJob(s.ctx), chen);

    s.stripe.fail({ path: '/refunds', network: true, times: 3 });

    const e = (await Promise.resolve(full.apply()).catch(
      (x: unknown) => x,
    )) as Error & {
      partial?: boolean;
    };

    expect(e.partial).toBe(true);
    expect(e.message).toMatch(/may have happened/);
  });

  it('a refused refund changed nothing: a plain error', async () => {
    const s = setup();
    const [full] = await plansOf(refundJob(s.ctx), chen);

    s.stripe.charges[0].amount_refunded = 100;

    const e = (await Promise.resolve(full.apply()).catch(
      (x: unknown) => x,
    )) as Error & {
      partial?: boolean;
    };

    expect(e.partial).toBeUndefined();
    expect(e.message).toBe(
      'Stripe: Refund amount is greater than unrefunded amount',
    );
  });
});

describe('who a call means', () => {
  it('several matches ask which, with the ids to call again with, and never guess', async () => {
    const s = setup();
    const out = (await refundJob(s.ctx).plan({
      customer: 'Ana',
      amount: '5',
    })) as Clarification;

    expect(out.clarify.question).toBe('2 customers match "Ana". Which one?');
    expect(out.clarify.options).toEqual([
      {
        label: '"Ana Ruiz" "ana.ruiz@acme.co" (cus_ana1)',
        params: { customer: 'cus_ana1', amount: '5' },
      },
      {
        label: '"Ana Li" "ana@northwind.io" (cus_ana2)',
        params: { customer: 'cus_ana2', amount: '5' },
      },
    ]);
    expect(s.stripe.writes()).toEqual([]);
  });

  it('a full page of matches says "5 or more"', async () => {
    const s = setup({
      state: (b) => ({
        customers: [...b.customers, ...customersNamed('Sam', 7)],
      }),
    });
    const out = (await refundJob(s.ctx).plan({
      customer: 'Sam',
    })) as Clarification;

    expect(out.clarify.question).toBe(
      '5 or more customers match "Sam". Which one?',
    );
    expect(out.clarify.options).toHaveLength(5);
  });

  it('an exact email finds one customer, straight away', async () => {
    const s = setup();

    expect(
      await plansOf(refundJob(s.ctx), { customer: 'chen@wei.studio' }),
    ).toHaveLength(2);
    expect(s.stripe.calls[0].path).toBe(
      '/v1/customers?email=chen%40wei.studio&limit=5',
    );
  });

  it('no match says how to find them', async () => {
    const s = setup();

    await expect(refundJob(s.ctx).plan({ customer: 'Nobody' })).rejects.toThrow(
      'no customer matches "Nobody"; try their exact email or cus_ id',
    );
  });
});
