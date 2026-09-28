/**
 * The "From REST to YEA" worked example (examples/stripe-jobs.ts) against a fake of the Stripe
 * endpoints it calls: the read, the refund that always asks, and the cancel that can be undone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createServer,
  connect as stripeClient,
} from '../../examples/stripe-jobs.js';
import { connect, grantPolicy, textOf, type World, world } from './helpers.js';

afterEach(() => {
  delete process.env.YEA_HOME;
});

const D = 86_400;
const now = Math.floor(Date.now() / 1000);

interface Call {
  method: string;
  path: string;
  body: string;
  key: string | null;
}

// A 30-day period with 14 whole days (and an hour) left: 14/30 of 49.00 USD is 22.87 USD.
const periodStart = now - 16 * D + 3600;

const customers = [
  { id: 'cus_ana1', name: 'Ana Ruiz', email: 'ana.ruiz@acme.co' },
  { id: 'cus_ana2', name: 'Ana Li', email: 'ana@northwind.io' },
  { id: 'cus_chen', name: 'Chen Wei', email: 'chen@wei.studio' },
];

function fakeStripe(currency = 'usd') {
  const calls: Call[] = [];
  const sub = {
    id: 'sub_chen',
    customer: 'cus_chen',
    status: 'active',
    cancel_at_period_end: false,
    items: {
      data: [
        {
          current_period_start: periodStart,
          current_period_end: periodStart + 30 * D,
          price: { id: 'price_pro', nickname: 'pro' },
        },
      ],
    },
  };
  const charge = {
    id: 'ch_2',
    customer: 'cus_chen',
    amount: 4900,
    amount_refunded: 0,
    currency,
    status: 'succeeded',
    created: now - 16 * D,
  };
  const ok = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace('/v1', '');
    const call = {
      method: init?.method ?? 'GET',
      path,
      body: String(init?.body ?? ''),
      key: new Headers(init?.headers).get('idempotency-key'),
    };

    calls.push(call);

    if (path === '/customers/search') {
      const q = u.searchParams.get('query') ?? '';
      const word = q.split('"')[1]?.toLowerCase() ?? '';

      return ok({
        data: customers.filter((c) => c.name.toLowerCase().includes(word)),
      });
    }

    if (path === '/charges') {
      return ok({ data: [charge] });
    }

    if (path === '/subscriptions') {
      return ok({ data: [sub] });
    }

    return ok({ id: 'x' });
  };

  return { calls, fetch: fetch as typeof globalThis.fetch };
}

function billing(w: Pick<World, 'approvals'>, currency?: string) {
  const stripe = fakeStripe(currency);
  const client = stripeClient('sk_test_x', stripe.fetch);

  return {
    calls: stripe.calls,
    writes: () => stripe.calls.filter((c) => c.method !== 'GET'),
    factory: () => createServer(w.approvals, client),
  };
}

describe('the billing example', () => {
  it('answers a question in one read, as a table', async () => {
    const w = await world();
    const b = billing(w);
    const conn = await connect('2026', b.factory);
    const r = await conn.call({ who: 'Chen' }, 'customer');

    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('payments[1]{id,date,amount,refunded}:');
    expect(textOf(r)).toContain('49.00 USD');
    expect(b.writes()).toEqual([]);
  });

  it('asks which customer when a read matches two, rather than picking one', async () => {
    const w = await world();
    const b = billing(w);
    const conn = await connect('2026', b.factory);
    const r = await conn.call({ who: 'Ana' }, 'customer');

    expect(r.structuredContent).toMatchObject({
      question: '2 customers match "Ana". Which one? Call again with its id.',
    });
    expect(textOf(r)).toContain('cus_ana1');
    expect(textOf(r)).toContain('cus_ana2');
    expect(b.calls.map((c) => c.path)).toEqual(['/customers/search']);
  });

  it('asks about a refund with both plans, and refunds the chosen one', async () => {
    const w = await world();
    const b = billing(w);
    const conn = await connect('2026', b.factory);
    const preview = await conn.call({ who: 'Chen', preview: true }, 'refund');
    const { plans } = preview.structuredContent as {
      plans: { planHash: string; summary: string }[];
    };

    expect(plans.map((p) => p.summary)).toEqual([
      'Refund 49.00 USD of ch_2 to Chen Wei (full)',
      'Refund 22.87 USD of ch_2 to Chen Wei (unused 14 days)',
    ]);

    conn.answers.push({
      action: 'accept',
      content: { plan: plans[1].planHash, confirm: 'approve' },
    });

    const r = await conn.call({ who: 'Chen' }, 'refund');

    expect(r.isError).toBeFalsy();
    expect(conn.elicited[0].message).toContain("refund can't be undone");
    expect(b.writes()).toHaveLength(1);
    expect(b.writes()[0].path).toBe('/refunds');
    expect(b.writes()[0].body).toBe('charge=ch_2&amount=2287');
  });

  it('uses a fresh idempotency key for every refund', async () => {
    const w = await world();
    const b = billing(w);
    const conn = await connect('2026', b.factory);

    for (let i = 0; i < 2; i++) {
      const { plans } = (
        await conn.call({ who: 'Chen', preview: true }, 'refund')
      ).structuredContent as { plans: { planHash: string }[] };

      conn.answers.push({
        action: 'accept',
        content: { plan: plans[0].planHash, confirm: 'approve' },
      });
      await conn.call({ who: 'Chen' }, 'refund');
    }

    const keys = b.writes().map((c) => c.key);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^yea-refund-/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('refuses a currency that is not two-decimal, and points to the connector', async () => {
    const w = await world();
    const b = billing(w, 'jpy');
    const conn = await connect('2026', b.factory);
    const r = await conn.call({ who: 'Chen' }, 'refund');

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("JPY isn't a two-decimal currency");
    expect(textOf(r)).toContain('@yea-protocol/stripe');
    expect(conn.elicited).toHaveLength(0);
    expect(b.writes()).toEqual([]);
  });

  it('asks which customer when a name matches two', async () => {
    const w = await world();
    const b = billing(w);
    const conn = await connect('2026', b.factory);
    const r = await conn.call({ who: 'Ana' }, 'refund');

    expect(textOf(r)).toContain('2 customers match "Ana". Which one?');
    expect(conn.elicited).toHaveLength(0);
    expect(b.writes()).toEqual([]);
  });

  it('cancels at period end on its own under a policy, and undoes it; a refund still asks', async () => {
    const w = await world();
    const b = billing(w);

    await grantPolicy(w, [{ can: ['cancel', 'refund'] }, { risk: 'medium' }]);

    const conn = await connect('2026', b.factory);
    const r = await conn.call({ who: 'Chen' }, 'cancel');
    const { receipt } = r.structuredContent as { receipt: { id: string } };

    expect(conn.elicited).toHaveLength(0);
    expect(b.writes()).toEqual([
      {
        method: 'POST',
        path: '/subscriptions/sub_chen',
        body: 'cancel_at_period_end=true',
        key: null,
      },
    ]);

    expect(
      (await conn.call({ receipt: receipt.id }, 'undo')).isError,
    ).toBeFalsy();
    expect(b.writes()[1].body).toBe('cancel_at_period_end=false');

    conn.answers.push({ action: 'decline' });
    await conn.call({ who: 'Chen' }, 'refund');
    expect(conn.elicited).toHaveLength(1);
    expect(b.writes()).toHaveLength(2);
  });
});
