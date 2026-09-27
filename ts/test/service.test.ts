import { beforeAll, describe, expect, it } from 'vitest';
import { calendar } from '../../examples/calendar.ts';
import { shop } from '../../examples/shop.ts';
import * as P from '../src/index.js';

let principal: P.KeyPair, agent: P.KeyPair;

beforeAll(async () => {
  principal = await P.keyPair();
  agent = await P.keyPair();
});

async function setup(caveats: P.Caveat[] = []) {
  const grant = await P.issueGrant({ principal, to: agent.public, caveats });
  const svc = calendar({ trust: [principal.public] });
  const client = new P.Client(P.local(svc), {
    key: agent.seed,
    grants: [grant],
  });

  return { svc, client, grant };
}

describe('calendar service', () => {
  it('HELLO returns a brief with capabilities', async () => {
    const { client } = await setup();
    const b = await client.hello();

    expect(b.kind).toBe('BRIEF');
    expect(b.lens).toContain('intent calendar.reschedule(');
  });

  it('ambiguous intents CLARIFY, then proposals, commit, undo', async () => {
    const { client } = await setup();
    const c = await client.intent('calendar.reschedule', { event: 'Ana' });

    expect(c.kind).toBe('CLARIFY');

    if (c.kind !== 'CLARIFY') {
      return;
    }

    const p = await client.intent('calendar.reschedule', {
      event: 'Ana',
      ...c.options[0].params,
    });

    expect(p.kind).toBe('PROPOSALS');

    if (p.kind !== 'PROPOSALS') {
      return;
    }

    expect(p.proposals.length).toBeGreaterThan(0);

    const before = await client.ask('calendar.agenda', { query: '1:1' });
    const r = await client.commit(p.proposals[0]);

    expect(r.kind).toBe('RECEIPT');

    if (r.kind !== 'RECEIPT') {
      return;
    }

    expect(r.lens).toMatch(/^✓ Move/);

    const again = await client.commit(p.proposals[0]);

    expect(again.kind === 'RECEIPT' && again.replay).toBe(true);

    const u = await client.undo(r.receipt.id);

    expect(u.kind).toBe('RECEIPT');
    expect(u.lens).toMatch(/^↶ undid/);

    const after = await client.ask('calendar.agenda', { query: '1:1' });

    expect(after.lens).toBe(before.lens);
  });

  it("teaches: typo'd capability and params get fixes", async () => {
    const { client } = await setup();
    const e = await client.ask('calendar.agnda', {});

    expect(e.kind).toBe('ERROR');
    expect(e.lens).toContain('did you mean calendar.agenda?');

    const e2 = await client.ask('calendar.free', { dya: '2026-01-01' });

    expect(e2.kind === 'ERROR' && e2.code).toBe('invalid_params');
    expect(e2.lens).toContain('rename `dya` to `day`');

    const e3 = await client.ask('calendar.reschedule', {});

    expect(e3.lens).toContain('send it with INTENT');
  });

  it('conflicts come with free-slot fixes', async () => {
    const { client } = await setup();
    const ag = await client.ask('calendar.agenda', { query: 'Design review' });
    const start = ((ag as P.Answer).data as { start: string }[])[0].start;
    const e = await client.intent('calendar.reschedule', {
      event: 'e2',
      to: start,
    });

    expect(e.kind === 'ERROR' && e.code).toBe('conflict');
    expect(e.kind === 'ERROR' && e.fix!.length).toBeGreaterThan(0);
  });

  it('COMMIT needs a grant; a grant for another service is forbidden', async () => {
    const svc = calendar({ trust: [principal.public] });
    const anon = new P.Client(P.local(svc));
    const p = await anon.intent('calendar.cancel', { event: 'e1' });

    expect(p.kind).toBe('PROPOSALS');

    if (p.kind !== 'PROPOSALS') {
      return;
    }

    const r = await anon.commit(p.proposals[0]);

    expect(r.kind === 'ERROR' && r.code).toBe('unauthorized');

    const wrong = await P.issueGrant({
      principal,
      to: agent.public,
      caveats: [{ can: ['calendar.book'] }],
    });
    const c2 = new P.Client(P.local(svc), { key: agent.seed, grants: [wrong] });
    const r2 = await c2.commit(p.proposals[0]);

    expect(r2.kind === 'ERROR' && r2.code).toBe('forbidden');
  });

  it('hash mismatch is a conflict (commit exactly what you saw)', async () => {
    const { client } = await setup();
    const p = await client.intent('calendar.cancel', { event: 'e1' });

    if (p.kind !== 'PROPOSALS') {
      throw new Error();
    }

    const r = await client.commit({ id: p.proposals[0].id, hash: 'tampered' });

    expect(r.kind === 'ERROR' && r.code).toBe('conflict');
  });

  it('proposals are inert: INTENT changes nothing', async () => {
    const { client } = await setup();
    const before = (await client.ask('calendar.agenda')).lens;

    await client.intent('calendar.cancel', { event: 'e3' });
    await client.intent('calendar.book', {
      title: 'x',
      with: ['a@b.c'],
      day: new Date(Date.now() + 86400e3).toISOString().slice(0, 10),
    });
    expect((await client.ask('calendar.agenda')).lens).toBe(before);
  });
});

describe('shop: budgets, money, consent', () => {
  it('fits big answers into the budget and EXPANDs the rest', async () => {
    const svc = shop({ trust: [] });
    const client = new P.Client(P.local(svc));
    const full = await client.ask('shop.search', {}, { budget: 100000 });

    expect(full.kind === 'ANSWER' && (full.data as unknown[]).length).toBe(60);

    const small = await client.ask('shop.search', {}, { budget: 300 });

    expect(P.est(small.lens)).toBeLessThanOrEqual(300);
    expect(small.kind === 'ANSWER' && small.more?.length).toBe(1);

    // expanding everything recovers the full list
    const got: unknown[] = [...((small as P.Answer).data as unknown[])];
    let more = (small as P.Answer).more?.[0];

    while (more) {
      const x = (await client.expand(more.handle, { budget: 300 })) as P.Answer;

      expect(P.est(x.lens)).toBeLessThanOrEqual(300);
      got.push(...(x.data as { items: unknown[] }).items);
      more = x.more?.[0];
    }

    expect(got).toEqual(full.kind === 'ANSWER' && full.data);
  });

  it('spend caps trigger consent; a consent grant binds the exact proposal', async () => {
    const svc = shop({ trust: [principal.public] });
    const grant = await P.issueGrant({
      principal,
      to: agent.public,
      caveats: [
        { svc: ['shop.example'] },
        { each: { of: 'spend', max: 5000, scale: 2, unit: 'USD' } },
        { total: { of: 'spend', max: 8000, scale: 2, unit: 'USD' } },
      ],
    });
    const client = new P.Client(P.local(svc), {
      key: agent.seed,
      grants: [grant],
    });
    const deliver = new Date(Date.now() + 2 * 86400e3)
      .toISOString()
      .slice(0, 10);

    const small = await client.intent('shop.order', {
      items: [{ sku: 'm001', qty: 2 }],
      deliver,
    });

    if (small.kind !== 'PROPOSALS') {
      throw new Error(small.lens);
    }

    const events: string[] = [];
    const ok = await client.commit(small.proposals[0], {
      onEvent: (e) => events.push(e.lens),
    });

    expect(ok.kind).toBe('RECEIPT');
    expect(events.length).toBe(2);

    const big = await client.intent('shop.order', {
      items: [{ sku: 'm002', qty: 4 }],
      deliver,
    });

    if (big.kind !== 'PROPOSALS') {
      throw new Error();
    }

    const denied = await client.commit(big.proposals[0]);

    expect(denied.kind === 'ERROR' && denied.code).toBe('consent_required');

    if (denied.kind !== 'ERROR') {
      return;
    }

    const consent = await P.consentGrant({
      principal,
      agent: agent.public,
      consent: denied.consent!,
    });
    // consent for one proposal doesn't work for the other
    const wrong = await client.commit(big.proposals[1], { grants: [consent] });

    expect(wrong.kind === 'ERROR' && wrong.code).toBe('consent_required');

    const approved = await client.commit(big.proposals[0], {
      grants: [consent],
    });

    expect(approved.kind).toBe('RECEIPT');
  });

  it("irreversible actions can't be undone", async () => {
    const svc = shop({ trust: [principal.public] });
    const grant = await P.issueGrant({ principal, to: agent.public });
    const client = new P.Client(P.local(svc), {
      key: agent.seed,
      grants: [grant],
    });
    const p = await client.intent('shop.tip', { order: 'o1', usd: 3 });

    if (p.kind !== 'PROPOSALS') {
      throw new Error(p.lens);
    }

    expect(p.lens).toContain('undo: never');

    const r = await client.commit(p.proposals[0]);

    if (r.kind !== 'RECEIPT') {
      throw new Error(r.lens);
    }

    const u = await client.undo(r.receipt.id);

    expect(u.kind === 'ERROR' && u.code).toBe('forbidden');
  });

  it('validates arrays of objects', async () => {
    const client = new P.Client(P.local(shop({ trust: [] })));
    const e = await client.intent('shop.order', {
      items: [{ sku: 'm001' }],
      deliver: '2026-01-01',
    });

    expect(e.kind === 'ERROR' && e.message).toContain('missing `items.0.qty`');
  });
});

describe('delegation to sub-agents', () => {
  it('a sub-agent can use an attenuated grant but not exceed it', async () => {
    const sub = await P.keyPair();
    const root = await P.issueGrant({
      principal,
      to: agent.public,
      caveats: [{ can: ['calendar.*'] }],
    });
    const narrowed = await P.delegateGrant(root, {
      holder: agent,
      to: sub.public,
      caveats: [{ can: ['calendar.book'] }],
    });
    const svc = calendar({ trust: [principal.public] });
    const client = new P.Client(P.local(svc), {
      key: sub.seed,
      grants: [narrowed],
    });
    const p = await client.intent('calendar.cancel', { event: 'e1' });

    if (p.kind !== 'PROPOSALS') {
      throw new Error();
    }

    const r = await client.commit(p.proposals[0]);

    expect(r.kind === 'ERROR' && r.code).toBe('forbidden');
  });
});

describe('consent grants authorize exactly one commit', () => {
  it('cannot undo an unrelated receipt, or be used for anything but that commit', async () => {
    const svc = shop({ trust: [principal.public] });
    const grant = await P.issueGrant({
      principal,
      to: agent.public,
      caveats: [{ each: { of: 'spend', max: 3000, scale: 2, unit: 'USD' } }],
    });
    const c = new P.Client(P.local(svc), { key: agent.seed, grants: [grant] });
    const a = await c.intent('shop.order', {
      items: [{ sku: 'm001', qty: 1 }],
      deliver: '2030-01-01',
    });

    if (a.kind !== 'PROPOSALS') {
      throw new Error();
    }

    const ra = await c.commit(a.proposals[0]);

    if (ra.kind !== 'RECEIPT') {
      throw new Error(ra.lens);
    }

    const b = await c.intent('shop.order', {
      items: [{ sku: 'm002', qty: 4 }],
      deliver: '2030-01-01',
    });

    if (b.kind !== 'PROPOSALS') {
      throw new Error();
    }

    const denied = await c.commit(b.proposals[0]);

    if (denied.kind !== 'ERROR' || !denied.consent) {
      throw new Error(denied.lens);
    }

    expect(denied.consent.service).toBe('shop.example');

    const consent = await P.consentGrant({
      principal,
      agent: agent.public,
      consent: denied.consent,
    });
    const onlyConsent = new P.Client(P.local(svc), {
      key: agent.seed,
      grants: [consent],
    });
    const undo = await onlyConsent.undo(ra.receipt.id);

    expect(undo.kind === 'ERROR' && undo.code).toBe('forbidden');
    expect((await onlyConsent.commit(b.proposals[0])).kind).toBe('RECEIPT');
    expect(P.decodeConsentCode(P.consentCode(denied.consent))).toEqual(
      denied.consent,
    );
  });
});
