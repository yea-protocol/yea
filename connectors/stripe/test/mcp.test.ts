/**
 * The connector over MCP, with the in-memory clients @yea-protocol/mcp's tests use: 2026 and
 * 2025 clients that can show a form, and ones that can't.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  accept,
  approve,
  connect,
  D,
  type Kind,
  NOW,
  suggestedGrant,
  textOf,
  world,
} from './helpers.js';

afterEach(() => {
  delete process.env.YEA_HOME;
  delete process.env.YEA_POLICY;
});

const chen = { customer: 'chen@wei.studio' };

describe('the tools', () => {
  it('are customer, the three jobs, and undo, each described for the Stripe API', async () => {
    const w = await world();
    const conn = await connect('2026', w.factory);
    const { tools } = await conn.client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'cancel_subscription',
      'change_plan',
      'customer',
      'refund',
      'undo',
    ]);

    for (const t of tools.filter((x) => x.name !== 'undo')) {
      expect(t.description).toContain('for the Stripe API');
    }

    expect(
      tools.find((t) => t.name === 'customer')?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(tools.find((t) => t.name === 'refund')?._meta).toEqual({
      'dev.yea/job': { risk: 'medium', undoable: false },
    });
    expect(tools.find((t) => t.name === 'cancel_subscription')?._meta).toEqual({
      'dev.yea/job': { risk: 'low', undoable: true },
    });
  });
});

describe('customer', () => {
  it('answers in one call, as Lens: plan, renewal, payments and what’s refundable', async () => {
    const w = await world();
    const conn = await connect('2025', w.factory);
    const r = await conn.call('customer', { customer: 'Chen' });

    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(
      [
        'mode: test',
        'id: cus_chen',
        'name: Chen Wei',
        'email: chen@wei.studio',
        'subscriptions[1]{id,plan,status,renews,schedule}:',
        '  sub_chen,pro (49.00 USD/month),active,2026-10-11,-',
        'payments[2]{id,date,amount,refunded,refundable,status}:',
        '  ch_2,2026-09-11,49.00 USD,0.00 USD,49.00 USD,succeeded',
        '  ch_1,2026-08-12,49.00 USD,0.00 USD,49.00 USD,succeeded',
      ].join('\n'),
    );
    expect(w.stripe.writes()).toEqual([]);
  });

  it('several matches list their ids; none is an error', async () => {
    const w = await world();
    const conn = await connect('2026', w.factory);

    expect(textOf(await conn.call('customer', { customer: 'Ana' }))).toBe(
      [
        '? 2 customers match "Ana". Call again with one of these ids:',
        '  "Ana Ruiz" "ana.ruiz@acme.co" (cus_ana1)',
        '  "Ana Li" "ana@northwind.io" (cus_ana2)',
      ].join('\n'),
    );

    const none = await conn.call('customer', { customer: 'Nobody' });

    expect(none.isError).toBe(true);
  });

  it('a Stripe permission error is a clear tool error', async () => {
    const w = await world();
    const conn = await connect('2026', w.factory);

    w.stripe.fail({
      path: '/customers/search',
      status: 403,
      message:
        "The provided key 'rk_test_***1234' does not have the required permissions for this endpoint. Having the 'rak_customer_read' permission would allow this request to continue.",
    });

    const r = await conn.call('customer', { customer: 'Chen' });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(
      /^✗ the Stripe key lacks a permission this needs \(Stripe says: .*'rak_customer_read'.*\)\. Add that permission to the restricted key, then try again$/,
    );
  });
});

describe.each<Kind>(['2026', '2025'])(
  'a %s client that can show a form',
  (kind) => {
    it('a refund always asks, even under a grant that names it; the typed amount runs it', async () => {
      const w = await world();

      await suggestedGrant(w, [
        { can: ['refund', 'cancel_subscription'] },
        { risk: 'high' },
      ]);

      const conn = await connect(kind, w.factory);

      conn.answers.push(accept(conn, 'approve'), accept(conn, ' 10.00 '));

      const r = await conn.call('refund', { ...chen, amount: '10' });

      expect(r.isError).toBeFalsy();
      expect(conn.elicited).toHaveLength(2);
      expect(conn.elicited[0].message).toMatch(/refund can't be undone/);
      expect(conn.elicited[0].requestedSchema).toMatchObject({
        properties: { confirm: { description: 'Type "10.00" to approve.' } },
      });
      expect(w.stripe.writes().map((c) => [c.path, c.body])).toEqual([
        ['/v1/refunds', 'payment_intent=pi_2&amount=1000'],
      ]);
      expect(textOf(r)).toMatch(
        /Refund 10.00 USD of ch_2 to "Chen Wei" \(partial\)/,
      );
      expect(r.structuredContent).toMatchObject({
        receipt: {
          tool: 'refund',
          undo: null,
          uses: { spend: { amount: 1000, scale: 2, unit: 'USD' } },
        },
        result: { plan: 'refund', refund: 're_1', amount: '10.00 USD' },
      });
    });

    it('cancel at period end auto-runs under the suggested grant in test mode, and can be undone', async () => {
      const w = await world();

      await suggestedGrant(w);

      const conn = await connect(kind, w.factory);
      const r = await conn.call('cancel_subscription', chen);

      expect(r.isError).toBeFalsy();
      expect(conn.elicited).toHaveLength(0);
      expect(w.stripe.subs[0].cancel_at_period_end).toBe(true);

      const { receipt } = r.structuredContent as {
        receipt: { id: string; undo: { until: number } };
      };

      expect(receipt.undo).not.toBeNull();

      const undo = await conn.call('undo', { receipt: receipt.id });

      expect(undo.isError).toBeFalsy();
      expect(w.stripe.subs[0].cancel_at_period_end).toBe(false);
      expect(w.stripe.writes().map((c) => c.body)).toEqual([
        'cancel_at_period_end=true',
        'cancel_at_period_end=false',
      ]);
    });

    it('a cheaper change at renewal auto-runs under the suggested grant in test mode, and undo releases it', async () => {
      const w = await world();

      await suggestedGrant(w);

      const conn = await connect(kind, w.factory);
      const r = await conn.call('change_plan', { ...chen, price: 'basic' });

      expect(r.isError).toBeFalsy();
      expect(conn.elicited).toHaveLength(0);
      expect(w.stripe.subs[0].schedule).toBe('sub_sched_1');

      const { receipt } = r.structuredContent as { receipt: { id: string } };

      expect(
        (await conn.call('undo', { receipt: receipt.id })).isError,
      ).toBeFalsy();
      expect(w.stripe.subs[0].schedule).toBeNull();
      expect(w.stripe.state.schedules[0].status).toBe('released');
    });

    it('the same grant auto-runs nothing in live mode', async () => {
      const w = await world({ live: true });

      await suggestedGrant(w);

      const conn = await connect(kind, w.factory);

      conn.answers.push({ action: 'decline' }, { action: 'decline' });

      for (const [tool, args] of [
        ['cancel_subscription', chen],
        ['change_plan', { ...chen, price: 'basic' }],
      ] as const) {
        const r = await conn.call(tool, args);

        expect(textOf(r)).toMatch(/not approved; nothing was run/);
      }

      expect(conn.elicited).toHaveLength(2);
      expect(conn.elicited[0].message).toMatch(/\[LIVE\] Cancel/);
      expect(w.stripe.writes()).toEqual([]);
    });

    it('a live refund is high risk: never offered in the form, only as a consent code', async () => {
      const w = await world({ live: true });
      const conn = await connect(kind, w.factory);
      const r = await conn.call('refund', { ...chen, amount: '10' });

      expect(conn.elicited).toHaveLength(0);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(
        /risk is high, which needs approval outside the chat/,
      );
      expect((r.structuredContent as { codes: unknown[] }).codes).toHaveLength(
        1,
      );
      expect(w.stripe.writes()).toEqual([]);
    });

    it('a plan that changes at midnight while the form is open asks again', async () => {
      const w = await world({ live: true });
      const conn = await connect(kind, w.factory);

      conn.answers.push(
        async () => {
          // The person answers after midnight: the undo window, and so the plan, changed.
          w.clock.now = NOW + D;

          return accept(conn, 'chen@wei.studio', 'at period end')();
        },
        { action: 'decline' },
      );

      const r = await conn.call('cancel_subscription', chen);

      expect(conn.elicited).toHaveLength(2);
      expect(conn.elicited[1].message).toMatch(
        /the plans changed; choose again/,
      );
      expect(textOf(r)).toMatch(/not approved/);
      expect(w.stripe.writes()).toEqual([]);
    });

    it('preview runs nothing', async () => {
      const w = await world();
      const conn = await connect(kind, w.factory);
      const r = await conn.call('change_plan', {
        ...chen,
        price: 'basic',
        preview: true,
      });

      expect(textOf(r)).toMatch(/^preview: nothing was run\n2 plans:/);
      expect(w.stripe.writes()).toEqual([]);
    });

    it('a plan that can’t be made is an error that says why, and nothing runs', async () => {
      const w = await world();
      const conn = await connect(kind, w.factory);
      const r = await conn.call('change_plan', {
        ...chen,
        price: 'price_pro_yearly',
      });

      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(
        /^✗ .*changing the billing interval isn't supported yet.*; nothing was run$/,
      );
    });

    it('ambiguity comes back as a question with the ids to call again with', async () => {
      const w = await world();
      const conn = await connect(kind, w.factory);
      const r = await conn.call('refund', { customer: 'Ana' });

      expect(textOf(r)).toBe(
        [
          '? 2 customers match "Ana". Which one?',
          '  1. "Ana Ruiz" "ana.ruiz@acme.co" (cus_ana1) → customer: cus_ana1',
          '  2. "Ana Li" "ana@northwind.io" (cus_ana2) → customer: cus_ana2',
        ].join('\n'),
      );
    });
  },
);

describe.each<Kind>(['2026-no-elicit', '2025-no-elicit'])(
  'a %s client',
  (kind) => {
    it('gets a consent code; after yea approve, the next call runs, once', async () => {
      const w = await world();
      const conn = await connect(kind, w.factory);
      const input = { ...chen, amount: '10' };
      const first = await conn.call('refund', input);

      expect(first.isError).toBe(true);
      expect(textOf(first)).toMatch(/Ask the user to run `yea approve <code>`/);
      expect(w.stripe.writes()).toEqual([]);

      const { codes } = first.structuredContent as {
        codes: { code: string }[];
      };
      const j = await approve(w, codes[0].code);

      expect(j.phrase).toBe('10.00');

      const second = await conn.call('refund', input);

      expect(second.isError).toBeFalsy();
      expect(w.stripe.writes()).toHaveLength(1);

      // The consent is used up: a third call asks again, and writes nothing.
      expect((await conn.call('refund', input)).isError).toBe(true);
      expect(w.stripe.writes()).toHaveLength(1);
    });

    it('a consent code from before midnight doesn’t run a plan that changed after it', async () => {
      const w = await world();
      const conn = await connect(kind, w.factory);
      const first = await conn.call('cancel_subscription', chen);
      const { codes } = first.structuredContent as {
        codes: { code: string }[];
      };

      await approve(w, codes[0].code);
      w.clock.now = NOW + D;
      expect((await conn.call('cancel_subscription', chen)).isError).toBe(true);
      expect(w.stripe.writes()).toEqual([]);
    });
  },
);

describe('a partial failure over MCP', () => {
  it('says which schedule was left, never "nothing changed"', async () => {
    const w = await world();

    await suggestedGrant(w);

    const conn = await connect('2026', w.factory);

    w.stripe.fail({
      path: '/subscription_schedules/sub_sched_1',
      status: 400,
      message: 'bad phase',
    });
    w.stripe.fail({
      path: '/subscription_schedules/sub_sched_1/release',
      status: 400,
      message: 'nope',
    });

    const r = await conn.call('change_plan', { ...chen, price: 'basic' });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(
      /failed part-way: .*sub_chen is left on subscription schedule sub_sched_1/,
    );
    expect(textOf(r)).not.toMatch(/nothing changed/);
  });
});
