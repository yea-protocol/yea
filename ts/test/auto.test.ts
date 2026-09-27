import { describe, expect, it } from 'vitest';
import { calendar } from '../../examples/calendar.ts';
import { shop } from '../../examples/shop.ts';
import * as P from '../src/index.js';

describe('policy-gated auto-commit', async () => {
  const principal = await P.keyPair(),
    agent = await P.keyPair();
  const deliver = '2030-01-01';

  it('commits in one round trip when the grant allows and the proposal is undoable', async () => {
    const grant = await P.issueGrant({
      principal,
      to: agent.public,
      caveats: [{ each: { of: 'spend', max: 5000, scale: 2, unit: 'USD' } }],
    });
    const c = new P.Client(P.local(shop({ trust: [principal.public] })), {
      key: agent.seed,
      grants: [grant],
    });
    const r = await c.intent(
      'shop.order',
      { items: [{ sku: 'm001', qty: 1 }], deliver },
      { auto: true },
    );

    expect(r.kind).toBe('RECEIPT');
    expect(r.lens).toMatch(/^✓ .* · undo until/);
    expect(r.lens).toContain('+ create charge');
  });

  it('falls back to proposals when consent would be needed', async () => {
    const grant = await P.issueGrant({
      principal,
      to: agent.public,
      caveats: [{ each: { of: 'spend', max: 500, scale: 2, unit: 'USD' } }],
    });
    const c = new P.Client(P.local(shop({ trust: [principal.public] })), {
      key: agent.seed,
      grants: [grant],
    });
    const r = await c.intent(
      'shop.order',
      { items: [{ sku: 'm001', qty: 1 }], deliver },
      { auto: true },
    );

    expect(r.kind).toBe('PROPOSALS');
  });

  it('never auto-commits irreversible proposals', async () => {
    const grant = await P.issueGrant({ principal, to: agent.public });
    const c = new P.Client(P.local(shop({ trust: [principal.public] })), {
      key: agent.seed,
      grants: [grant],
    });
    const r = await c.intent(
      'shop.tip',
      { order: 'o1', usd: 2 },
      { auto: true },
    );

    expect(r.kind).toBe('PROPOSALS');
  });

  it('without a grant it is just an INTENT', async () => {
    const c = new P.Client(P.local(calendar({ trust: [principal.public] })));

    expect(
      (await c.intent('calendar.cancel', { event: 'e1' }, { auto: true })).kind,
    ).toBe('PROPOSALS');
  });

  it('a replayed auto frame returns the original receipt instead of committing again', async () => {
    const grant = await P.issueGrant({ principal, to: agent.public });
    const svc = shop({ trust: [principal.public] });
    const frames: P.Request[] = [];
    const t = P.local(svc);
    const spy: P.Transport = {
      request: (f, e) => {
        frames.push(f);

        return t.request(f, e);
      },
      close() {},
    };
    const c = new P.Client(spy, { key: agent.seed, grants: [grant] });
    const first = await c.intent(
      'shop.order',
      { items: [{ sku: 'm001', qty: 1 }], deliver },
      { auto: true },
    );

    if (first.kind !== 'RECEIPT') {
      throw new Error(first.lens);
    }

    const captured = frames.find((f) => f.verb === 'INTENT')!;
    const again = await svc.handle(structuredClone(captured));

    expect(again.kind === 'RECEIPT' && again.replay).toBe(true);
    expect(again.kind === 'RECEIPT' && again.receipt.id).toBe(first.receipt.id);

    // tampering with the id breaks the proof binding → falls back to plain proposals
    const forged = await svc.handle({
      ...structuredClone(captured),
      id: 'other',
    });

    expect(forged.kind).toBe('ERROR');
  });
  it('reserves a total on the auto-commit path, so the next auto-commit past it asks', async () => {
    const grant = await P.issueGrant({
      principal,
      to: agent.public,
      caveats: [{ total: { of: 'spend', max: 3000, scale: 2, unit: 'USD' } }],
    });
    const c = new P.Client(P.local(shop({ trust: [principal.public] })), {
      key: agent.seed,
      grants: [grant],
    });
    const order = () =>
      c.intent(
        'shop.order',
        { items: [{ sku: 'm001', qty: 1 }], deliver },
        { auto: true },
      );

    expect((await order()).kind).toBe('RECEIPT');
    expect((await order()).kind).toBe('PROPOSALS');
  });
});

describe('budget fitting never alters proposals', () => {
  it('drops whole proposals and elides data first, never effects', async () => {
    const svc = P.service({ id: 't', name: 'T', summary: 't' }).intent('t.x', {
      summary: 'x',
      plan: () =>
        Array.from({ length: 6 }, (_, i) => ({
          summary: `option ${i}`,
          effects: Array.from({ length: 5 }, (_, j) =>
            P.send(
              `user${j}@example.com`,
              'a fairly long notification detail line',
            ),
          ),
          data: { blob: 'x'.repeat(3000) },
          apply: () => null,
        })),
    });
    const c = new P.Client(P.local(svc));
    const r = await c.intent('t.x', {}, { budget: 400 });

    if (r.kind !== 'PROPOSALS') {
      throw new Error();
    }

    expect(r.proposals.length).toBeGreaterThan(0);

    for (const p of r.proposals) {
      expect(p.effects.length).toBe(5);
    }

    expect(r.proposals[0].hash).toBe(await P.proposalHash(r.proposals[0]));
  });
});

describe('budget accounting uses the real handles', () => {
  it('never overshoots the budget when several paths are elided', async () => {
    const svc = P.service({ id: 't', name: 'T', summary: 't' }).ask('t.two', {
      summary: 'two lists',
      run: () => ({
        a: Array.from({ length: 80 }, (_, i) => `item-${i}-x9`),
        b: Array.from({ length: 80 }, (_, i) => ({ n: i, v: `v${i * 7}` })),
      }),
    });
    const c = new P.Client(P.local(svc));

    for (let budget = 70; budget <= 600; budget += 7) {
      const r = await c.ask('t.two', {}, { budget });

      expect(P.est(r.lens), `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });
});
