// The guide's full example (examples/stripe-billing.ts), which reads Stripe through this
// package's client, against the same fake of the Stripe endpoints.
import * as P from '@yea-protocol/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { stripeBilling } from '../../../examples/stripe-billing.js';
import { fakeStripe } from './fake-stripe.js';

let principal: P.KeyPair, agent: P.KeyPair;

beforeAll(async () => {
  principal = await P.keyPair();
  agent = await P.keyPair();
});

async function setup(
  caveats: P.Caveat[] = [],
  stripe: ReturnType<typeof fakeStripe> = fakeStripe(),
) {
  const grant = await P.issueGrant({ principal, to: agent.public, caveats });
  const client = new P.Client(
    P.local(
      stripeBilling({
        key: 'sk_test_x',
        trust: [principal.public],
        fetch: stripe.fetch,
      }),
    ),
    { key: agent.seed, grants: [grant] },
  );

  return { client, stripe };
}

describe("Stripe-backed billing (the guide's full example)", () => {
  it('one ASK joins customer, subscription and charges', async () => {
    const { client } = await setup();
    const r = await client.ask('billing.customer', { who: 'Chen' });

    expect(r.kind).toBe('ANSWER');
    expect(r.lens).toContain('payments[2]{id,date,amount,refunded,status}:');
    expect(r.lens).toContain('plan: pro');
  });

  it('ambiguous names CLARIFY; a refund offers full or unused, and is never auto-committed', async () => {
    const { client, stripe } = await setup([{ risk: 'medium' }]);

    expect((await client.intent('billing.refund', { who: 'Ana' })).kind).toBe(
      'CLARIFY',
    );

    const r = await client.intent(
      'billing.refund',
      { who: 'Chen' },
      { auto: true },
    );

    if (r.kind !== 'PROPOSALS') {
      throw new Error(r.kind);
    }

    expect(r.proposals).toHaveLength(2);
    expect(r.proposals.every((p) => p.undo === null)).toBe(true);
    expect(stripe.calls.some((c) => c.path === '/v1/refunds')).toBe(false);

    const receipt = await client.commit(r.proposals[1]);

    expect(receipt.kind).toBe('RECEIPT');

    const call = stripe.calls.find((c) => c.path === '/v1/refunds')!;

    expect(call.body).toMatch(
      /^charge=ch_2&amount=\d+&reason=requested_by_customer$/,
    );
    // A fresh random key per write, never one derived from the plan.
    expect(call.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.version).toBe('2026-08-26.dahlia');
    expect(stripe.charges[0].amount_refunded).toBeGreaterThan(0);
  });

  it('cancel at period end is undone with the inverse REST call', async () => {
    const { client, stripe } = await setup([{ risk: 'low' }]);
    const r = await client.intent(
      'billing.cancel',
      { who: 'chen@wei.studio' },
      { auto: true },
    );

    if (r.kind !== 'RECEIPT') {
      throw new Error(r.kind);
    }

    expect(stripe.subs[0].cancel_at_period_end).toBe(true);
    await client.undo(r.receipt.id);
    expect(stripe.subs[0].cancel_at_period_end).toBe(false);
    expect(
      stripe.calls.filter((c) => c.method === 'POST').map((c) => c.body),
    ).toEqual(['cancel_at_period_end=true', 'cancel_at_period_end=false']);
  });

  it('Stripe errors become teaching errors', async () => {
    const { client } = await setup();
    const r = await client.ask('billing.customer', { who: 'cus_nope' });

    expect(r.kind === 'ERROR' && r.code).toBe('not_found');
    expect(r.lens).toContain('fix:');
  });

  it('a refund whose result is unknown is not retryable: it may have happened', async () => {
    const { client, stripe } = await setup([{ risk: 'medium' }]);
    const r = await client.intent('billing.refund', { who: 'Chen' });

    if (r.kind !== 'PROPOSALS') {
      throw new Error(r.kind);
    }

    // Every answer is lost; the SDK's own retries reuse the key.
    stripe.fail({ path: '/refunds', network: true, times: 3 });

    const out = await client.commit(r.proposals[0]);

    expect(out.kind).toBe('ERROR');

    if (out.kind !== 'ERROR') {
      return;
    }

    expect(out.code).toBe('conflict');
    expect(out.retry ?? null).toBeNull();
    expect(out.lens).toMatch(/may have happened; check the Stripe dashboard/);
  });

  it('amounts follow the currency: yen have no decimals', async () => {
    const stripe = fakeStripe();

    for (const ch of stripe.charges) {
      ch.currency = 'jpy';
      ch.amount = 4900;
    }

    const { client } = await setup([], stripe);
    const r = await client.ask('billing.customer', { who: 'Chen' });

    expect(r.lens).toContain('ch_2,');
    expect(r.lens).toContain('4900 JPY');
  });
});
