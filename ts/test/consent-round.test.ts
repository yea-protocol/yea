// The consent round (consent-round.ts) at its interface: its consent store, and how each answer
// an approver can give ends it. Its security cases (C1–C5, C8–C11) are in security.test.ts.
import { describe, expect, it } from 'vitest';
import { shop } from '../../examples/shop.ts';
import * as P from '../src/index.js';

const principal = await P.keyPair(),
  agent = await P.keyPair();

/** A shop client with a grant too small for a big order, counting its COMMITs; and that order. */
async function bigOrder() {
  const t = P.local(shop({ trust: [principal.public] }));
  const commits: P.Request[] = [];
  const c = new P.Client(
    {
      ...t,
      request: (f, on) => {
        if (f.verb === 'COMMIT') {
          commits.push(f);
        }

        return t.request(f, on);
      },
    },
    {
      key: agent.seed,
      grants: [
        await P.issueGrant({
          principal,
          to: agent.public,
          caveats: [{ each: { of: 'spend', max: 100, scale: 2, unit: 'USD' } }],
        }),
      ],
    },
  );
  const r = await c.intent('shop.order', {
    items: [{ sku: 'm001', qty: 20 }],
    deliver: '2030-01-01',
  });

  if (r.kind !== 'PROPOSALS') {
    throw new Error(r.lens);
  }

  return { c, commits, p: r.proposals[0] };
}

/** An approver that counts its asks before giving `answer`. */
function counted(answer: P.Approver) {
  const asks: P.ConsentAsk[] = [];

  return {
    asks,
    approver: (a: P.ConsentAsk) => {
      asks.push(a);

      return answer(a);
    },
  };
}

const yes = P.signer(principal, async () => true);

describe('consentRound', () => {
  it('keeps the consent it was given, and a later round commits with it before asking', async () => {
    const consents = P.memoryConsents();
    const first = await bigOrder();
    const asked = counted(yes);
    const out = await P.consentRound({
      client: first.c,
      proposal: first.p,
      approver: asked.approver,
      consents,
    });

    expect(out.kind === 'reply' && out.reply.kind).toBe('RECEIPT');
    expect(out.saved).toBeNull();
    expect(asked.asks).toHaveLength(1);
    expect(await consents.get(first.p.hash)).toBe(
      out.kind === 'reply' && out.consent,
    );

    // The same proposal again: its kept consent goes on the first COMMIT, so no one is asked.
    const again = counted(yes);
    const replay = await P.consentRound({
      client: first.c,
      proposal: first.p,
      approver: again.approver,
      consents,
    });

    expect(replay.kind === 'reply' && replay.reply.kind).toBe('RECEIPT');
    expect(replay.saved).toBe(await consents.get(first.p.hash));
    expect(again.asks).toEqual([]);
    expect(first.commits).toHaveLength(3);
  });

  it('out of band, it ends with a code carrying the proposal and the agent, and commits once', async () => {
    const { c, commits, p } = await bigOrder();
    const out = await P.consentRound({
      client: c,
      proposal: p,
      approver: P.outOfBand(),
    });

    expect(out.kind).toBe('pending');

    const code = P.decodeConsentCode(out.kind === 'pending' ? out.code : '');

    expect(code).toMatchObject({
      proposal: p.id,
      hash: p.hash,
      principal: principal.public,
      agent: agent.public,
      detail: { id: p.id, hash: p.hash },
    });
    expect(commits).toHaveLength(1);
  });

  it('a decline ends it with the service error, and commits once', async () => {
    const { c, commits, p } = await bigOrder();
    const out = await P.consentRound({
      client: c,
      proposal: p,
      approver: P.signer(principal, async () => false),
    });

    expect(out.kind).toBe('declined');
    expect(out.reply.kind === 'ERROR' && out.reply.code).toBe(
      'consent_required',
    );
    expect(commits).toHaveLength(1);
  });

  it('an agent without a key is refused before anyone is asked', async () => {
    const { c, p } = await bigOrder();
    const asking = await c.commit(p);
    const asked = counted(yes);
    const out = await P.consentRound({
      client: {
        key: undefined,
        audience: () => c.audience(),
        commit: async () => asking,
      },
      proposal: p,
      approver: asked.approver,
    });

    expect(asking.kind === 'ERROR' && asking.code).toBe('consent_required');
    expect(out.kind === 'refused' && out.why).toBe(
      'the agent has no key to commit a consent with',
    );
    expect(asked.asks).toEqual([]);
  });
});
