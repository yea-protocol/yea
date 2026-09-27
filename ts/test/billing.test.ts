import { beforeAll, describe, expect, it } from 'vitest';
import { billing } from '../../examples/billing.ts';
import * as P from '../src/index.js';

let principal: P.KeyPair, agent: P.KeyPair;

beforeAll(async () => {
  principal = await P.keyPair();
  agent = await P.keyPair();
});

async function setup(caveats: P.Caveat[] = []) {
  const grant = await P.issueGrant({ principal, to: agent.public, caveats });
  const client = new P.Client(P.local(billing({ trust: [principal.public] })), {
    key: agent.seed,
    grants: [grant],
  });

  return { client };
}

describe('billing example (service design guide)', () => {
  it('resolves people by name, and CLARIFYs when ambiguous', async () => {
    const { client } = await setup();
    const c = await client.intent('billing.cancel', { who: 'Ana' });

    expect(c.kind).toBe('CLARIFY');

    const one = await client.ask('billing.customer', {
      who: 'ana.ruiz@acme.co',
    });

    expect(one.kind).toBe('ANSWER');

    const amb = await client.ask('billing.customer', { who: 'Ana' });

    expect(amb.kind === 'ERROR' && amb.fix?.length).toBe(2);
  });

  it('refunds are irreversible, so auto:true never skips the human', async () => {
    const { client } = await setup([{ risk: 'medium' }]);
    const r = await client.intent(
      'billing.refund',
      { who: 'Chen' },
      { auto: true },
    );

    expect(r.kind).toBe('PROPOSALS');

    if (r.kind !== 'PROPOSALS') {
      return;
    }

    expect(r.proposals.map((p) => p.undo)).toEqual([null, null]);
    expect(r.proposals[0].uses).toEqual({
      spend: { amount: 4900, scale: 2, unit: 'USD' },
    });
  });

  it('a per-action cap makes large refunds need consent', async () => {
    const { client } = await setup([
      { risk: 'medium' },
      { each: { of: 'spend', max: 2000, scale: 2, unit: 'USD' } },
    ]);
    const r = await client.intent('billing.refund', { who: 'Chen' });

    if (r.kind !== 'PROPOSALS') {
      throw new Error(r.kind);
    }

    const c = await client.commit(r.proposals[0]);

    expect(c.kind === 'ERROR' && c.code).toBe('consent_required');
  });

  it('scheduling a plan change auto-commits under a low-risk grant, and undoes', async () => {
    const { client } = await setup([{ risk: 'low' }]);
    const p = await client.intent('billing.change_plan', {
      who: 'Dana',
      plan: 'pro',
    });

    if (p.kind !== 'PROPOSALS') {
      throw new Error(p.kind);
    }

    expect(p.proposals).toHaveLength(2);

    const r = await client.commit(p.proposals[1]);

    if (r.kind !== 'RECEIPT') {
      throw new Error(r.kind);
    }

    const dana = async () =>
      ((await client.ask('billing.customer', { who: 'dana' })) as P.Answer)
        .data as Record<string, unknown>;

    // Scheduled for renewal: still on team today, with pro pending.
    expect(await dana()).toMatchObject({ plan: 'team', next_plan: 'pro' });
    await client.undo(r.receipt.id);
    expect((await dana()).next_plan).toBeUndefined();
  });

  it('cancel offers an undoable end-of-period option and a riskier immediate one', async () => {
    const { client } = await setup();
    const p = await client.intent('billing.cancel', { who: 'Ben' });

    if (p.kind !== 'PROPOSALS') {
      throw new Error(p.kind);
    }

    expect(p.proposals.map((x) => x.risk)).toEqual(['low', 'medium']);
    expect(p.proposals[0].undo).not.toBeNull();
    expect(p.proposals[1].undo).toBeNull();
  });
});
