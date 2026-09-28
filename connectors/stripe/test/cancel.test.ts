import { describe, expect, it } from 'vitest';
import { cancelJob } from '../src/cancel.js';
import { price, type Schedule, subscription } from './fake-stripe.js';
import { D, NOW, plansOf, setup } from './helpers.js';

const chen = { customer: 'chen@wei.studio' };

/** A schedule on sub_chen, in its last phase, ending at the period end, unless `later` adds one. */
function scheduled(o: { later?: boolean; end_behavior?: string } = {}) {
  return setup({
    state: (b) => {
      const sub = b.subs[0];
      const item = sub.items.data[0];
      const phase = {
        start_date: item.current_period_start,
        end_date: item.current_period_end,
        items: [{ price: 'price_pro', quantity: 1 }],
      };
      const s: Schedule = {
        id: 'sub_sched_theirs',
        subscription: sub.id,
        status: 'active',
        end_behavior: o.end_behavior ?? 'release',
        current_phase: {
          start_date: phase.start_date,
          end_date: phase.end_date,
        },
        phases: o.later
          ? [
              phase,
              {
                start_date: phase.end_date,
                end_date: phase.end_date + 30 * D,
                items: [{ price: 'price_team', quantity: 1 }],
              },
            ]
          : [phase],
      };

      return { subs: [{ ...sub, schedule: s.id }], schedules: [s] };
    },
  });
}

describe('cancel_subscription plans', () => {
  it('offers at period end (undoable until a day before it), then now', async () => {
    const s = setup();
    const [atEnd, now] = await plansOf(cancelJob(s.ctx), chen);

    expect(atEnd).toMatchObject({
      summary:
        '[test] Cancel "Chen Wei"\'s pro subscription (sub_chen) at period end, 2026-10-11; access until then',
      effects: [
        {
          op: 'update',
          target: 'subscription/sub_chen',
          field: 'cancel_at_period_end',
          from: false,
          to: true,
          detail: 'ends 2026-10-11',
        },
      ],
      risk: 'low',
      // 14 days 10 hours from the start of today, less a day, in whole days.
      undoWindow: 13 * D,
      data: { confirm: 'chen@wei.studio' },
    });
    expect(now).toMatchObject({
      summary:
        '[test] Cancel "Chen Wei"\'s pro subscription (sub_chen) now; access ends immediately, with no refund',
      effects: [
        {
          target: 'subscription/sub_chen',
          field: 'status',
          from: 'active',
          to: 'canceled',
        },
      ],
      risk: 'medium',
    });
    expect(now.undoWindow).toBeUndefined();
    expect(s.stripe.writes()).toEqual([]);
  });

  it('at period end is one POST, undone by setting it back', async () => {
    const s = setup();
    const job = cancelJob(s.ctx);
    const [atEnd] = await plansOf(job, chen);
    const result = await atEnd.apply();

    expect(result).toEqual({
      plan: 'cancel_at_period_end',
      subscription: 'sub_chen',
    });
    expect(s.stripe.subs[0].cancel_at_period_end).toBe(true);

    await job.revert?.(chen, result);
    expect(s.stripe.subs[0].cancel_at_period_end).toBe(false);
    expect(s.stripe.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      ['POST', '/v1/subscriptions/sub_chen', 'cancel_at_period_end=true'],
      ['POST', '/v1/subscriptions/sub_chen', 'cancel_at_period_end=false'],
    ]);
    // Undo makes its own fresh key.
    expect(s.stripe.writes()[0].key).not.toBe(s.stripe.writes()[1].key);
  });

  it('now is one DELETE', async () => {
    const s = setup();
    const [, now] = await plansOf(cancelJob(s.ctx), chen);

    expect(await now.apply()).toEqual({
      plan: 'cancel_now',
      subscription: 'sub_chen',
    });
    expect(s.stripe.writes().map((w) => [w.method, w.path])).toEqual([
      ['DELETE', '/v1/subscriptions/sub_chen'],
    ]);
    expect(s.stripe.subs[0].status).toBe('canceled');
  });

  it('a subscription already cancelling only gets "now"', async () => {
    const s = setup();

    s.stripe.subs[0].cancel_at_period_end = true;
    expect((await plansOf(cancelJob(s.ctx), chen)).map((p) => p.risk)).toEqual([
      'medium',
    ]);
  });

  it('a period end less than a day away leaves at period end with no undo window', async () => {
    const s = setup();

    s.stripe.subs[0].items.data[0].current_period_end = NOW + 20 * 3600;

    const [atEnd] = await plansOf(cancelJob(s.ctx), chen);

    expect(atEnd.summary).toContain('at period end');
    expect(atEnd.undoWindow).toBeUndefined();
  });

  it('on a schedule, at period end sets the schedule to cancel, and undo sets it back to release', async () => {
    const s = scheduled();
    const job = cancelJob(s.ctx);
    const [atEnd, now] = await plansOf(job, chen);

    expect(atEnd.effects).toEqual([
      {
        op: 'update',
        target: 'subscription_schedule/sub_sched_theirs',
        field: 'end_behavior',
        from: 'release',
        to: 'cancel',
        detail: 'sub_chen ends 2026-10-11',
      },
    ]);
    expect(now.summary).toContain('now');

    const result = await atEnd.apply();

    expect(result).toEqual({
      plan: 'cancel_at_period_end',
      schedule: 'sub_sched_theirs',
      subscription: 'sub_chen',
    });
    expect(s.stripe.state.schedules[0].end_behavior).toBe('cancel');

    await job.revert?.(chen, result);
    expect(s.stripe.state.schedules[0].end_behavior).toBe('release');
    expect(s.stripe.writes().map((w) => [w.path, w.body])).toEqual([
      ['/v1/subscription_schedules/sub_sched_theirs', 'end_behavior=cancel'],
      ['/v1/subscription_schedules/sub_sched_theirs', 'end_behavior=release'],
    ]);
    // Never the subscription's own flag, which Stripe refuses on a scheduled subscription.
    expect(
      s.stripe.writes().some((w) => w.path.startsWith('/v1/subscriptions/')),
    ).toBe(false);
  });

  it('on a schedule with a later phase, or already cancelling, only "now"', async () => {
    for (const s of [
      scheduled({ later: true }),
      scheduled({ end_behavior: 'cancel' }),
    ]) {
      const plans = await plansOf(cancelJob(s.ctx), chen);

      expect(plans.map((p) => p.summary.includes(' now;'))).toEqual([true]);
    }
  });

  it('refuses a subscription with more than one item', async () => {
    const s = setup();
    const item = s.stripe.subs[0].items.data[0];

    s.stripe.subs[0].items.data.push({
      ...item,
      id: 'si_extra',
      price: price('price_addon', 500),
    });
    await expect(cancelJob(s.ctx).plan(chen)).rejects.toThrow(
      /sub_chen has 2 items; subscriptions with more than one item aren't supported yet/,
    );
  });

  it('several subscriptions ask which; none is an error', async () => {
    const s = setup({
      state: (b) => ({
        subs: [
          ...b.subs,
          subscription('sub_chen2', 'cus_chen', b.prices[1], {
            start: NOW - D,
            end: NOW + 29 * D,
          }),
        ],
      }),
    });
    const out = await cancelJob(s.ctx).plan(chen);

    expect(out).toMatchObject({
      clarify: {
        question: '"Chen Wei" has 2 subscriptions. Which one?',
        options: [
          { params: { subscription: 'sub_chen2' } },
          {
            label: 'sub_chen: pro (49.00 USD/month) (active)',
            params: { customer: 'cus_chen', subscription: 'sub_chen' },
          },
        ],
      },
    });
    expect(
      await plansOf(cancelJob(s.ctx), { ...chen, subscription: 'sub_chen2' }),
    ).toHaveLength(2);

    s.stripe.subs.forEach((x) => {
      x.status = 'canceled';
    });
    await expect(cancelJob(s.ctx).plan(chen)).rejects.toThrow(
      '"Chen Wei" has no active subscription',
    );
  });

  it('refuses to undo anything but at period end', async () => {
    const s = setup();
    const job = cancelJob(s.ctx);

    for (const bad of [
      null,
      { plan: 'cancel_now', subscription: 'sub_chen' },
      { plan: 'cancel_at_period_end', subscription: '../refunds' },
      {
        plan: 'cancel_at_period_end',
        subscription: 'sub_chen',
        schedule: 'x/y',
      },
    ]) {
      await expect(job.revert?.(chen, bad)).rejects.toThrow();
    }

    expect(s.stripe.writes()).toEqual([]);
  });
});
