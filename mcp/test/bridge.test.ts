/**
 * The bridge (SPEC-bridge, Testing): the example services in-process, behind MCP clients of
 * both eras, with and without elicitation: job calls, proposals near expiry, consents that fail
 * to commit, deny and unreadable policy files, and the utilities. Security cases are in
 * bridge-security.test.ts.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { service, unixNow } from '@yea-protocol/sdk';
import { shop } from '@yea-protocol/sdk/examples';
import { saveGrant } from '@yea-protocol/sdk/node';
import { afterEach, describe, expect, it } from 'vitest';
import { bridge } from '../src/bridge.js';
import {
  agentClient,
  approveCode,
  BIG_ORDER,
  bridged,
  examples,
  type Keys,
  keys,
  proposalsOf,
  recorded,
  SMALL_ORDER,
  writePolicy,
} from './bridge-helpers.js';
import { connect, type Kind, textOf } from './helpers.js';

const shopService = (k: Keys) => shop({ trust: [k.principal.public] });

/** A service whose one job offers two plans that expire `a` and `b` seconds from now. */
function twoTimes(k: Keys, a: number, b: number) {
  return service({
    id: 'lab.example',
    name: 'Lab',
    summary: 's',
    trust: [k.principal.public],
  }).intent('lab.pick', {
    summary: 'pick',
    params: { 'n?': 'int' },
    risk: 'high',
    plan: () =>
      [a, b].map((expiresIn, i) => ({
        summary: `plan ${i}`,
        effects: [{ op: 'create' as const, target: `thing/${i}` }],
        expiresIn,
        apply: () => ({ plan: i }),
      })),
  });
}

afterEach(() => {
  delete process.env.YEA_HOME;
});

describe.each<Kind>([
  '2026',
  '2025',
  '2026-no-elicit',
  '2025-no-elicit',
  'stdio-2026',
  'stdio-2025',
])('a %s client', (kind) => {
  it('lists one tool per capability, plus the utilities', async () => {
    const k = await keys();
    const { conn } = await bridged(k, kind);
    const { tools } = await conn.client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'calendar_agenda',
      'calendar_book',
      'calendar_cancel',
      'calendar_free',
      'calendar_reschedule',
      'shop_order',
      'shop_orders',
      'shop_search',
      'shop_tip',
      'yea_consent',
      'yea_expand',
      'yea_undo',
    ]);
  });

  it('a call the grant allows commits in one call', async () => {
    const k = await keys();
    const { conn, shop } = await bridged(k, kind);
    const r = await conn.call(SMALL_ORDER, 'shop_order');

    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/^✓ 1 meals for 2030-01-01/);
    expect(shop.verbs('INTENT')).toHaveLength(1);
    expect(shop.verbs('COMMIT')).toHaveLength(0);
  });

  it('over the grant: codes; yea approve, yea_consent and the same call commit it once', async () => {
    const k = await keys();
    const { conn, shop } = await bridged(k, kind);
    const first = await conn.call(BIG_ORDER, 'shop_order');
    const { proposals, codes } = proposalsOf(first);

    expect(first.isError).toBeFalsy();
    expect(textOf(first)).toMatch(/^nothing was run/);
    expect(textOf(first)).toContain('yea approve');
    expect(codes.map((c) => c.proposal)).toEqual(proposals.map((p) => p.id));

    const token = await approveCode(k.principal, codes[1].code);
    const saved = await conn.call({ token }, 'yea_consent');

    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toContain(`[${proposals[1].id}]`);

    const done = await conn.call(BIG_ORDER, 'shop_order');

    expect(done.isError).toBeFalsy();
    expect(textOf(done)).toContain('(express, by noon)');
    expect(shop.verbs('COMMIT')).toHaveLength(1);

    // Once: the next identical call starts over, with fresh proposals.
    const again = await conn.call(BIG_ORDER, 'shop_order');

    expect(proposalsOf(again).proposals[0].id).not.toBe(proposals[0].id);
    expect(shop.verbs('COMMIT')).toHaveLength(1);
  });
});

describe('a job tool call', () => {
  it('a call naming proposal commits an irreversible proposal the grant allows', async () => {
    const k = await keys();
    const { conn, shop } = await bridged(k);
    const tip = { order: 'o1', usd: 2.5 };
    const first = await conn.call(tip, 'shop_tip');
    const [p] = proposalsOf(first).proposals;

    // Irreversible, so the service didn't auto-commit it, though the grant allows it.
    expect(textOf(first)).toContain('undo: never');
    expect(shop.verbs('COMMIT')).toHaveLength(0);

    const done = await conn.call({ ...tip, proposal: p.id }, 'shop_tip');

    expect(done.isError).toBeFalsy();
    expect(textOf(done)).toMatch(
      /^✓ Tip 2.5 USD on o1 \(receipt r_.*\) · irreversible/,
    );
    expect(shop.verbs('COMMIT')).toHaveLength(1);
  });

  it('a call naming proposal over the grant gets its code, not a commit', async () => {
    const k = await keys();
    const { conn } = await bridged(k);
    const tip = { order: 'o1', usd: 50 };
    const [p] = proposalsOf(await conn.call(tip, 'shop_tip')).proposals;
    const r = await conn.call({ ...tip, proposal: p.id }, 'shop_tip');
    const { codes } = proposalsOf(r);

    expect(textOf(r)).toMatch(/needs the user's approval/);
    expect(codes).toHaveLength(1);
    expect(codes[0].proposal).toBe(p.id);
  });

  it('a proposal id not pending for these arguments is refused', async () => {
    const k = await keys();
    const { conn, shop } = await bridged(k);
    const r = await conn.call(
      { ...BIG_ORDER, proposal: 'p_nope' },
      'shop_order',
    );

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/isn't pending for these arguments/);
    expect(shop.verbs('INTENT')).toHaveLength(0);
  });

  it('float params hash and cache: the same call returns the same proposals, with no new INTENT', async () => {
    const k = await keys();
    const { conn, shop } = await bridged(k);
    const a = await conn.call({ order: 'o1', usd: 0.1 }, 'shop_tip');
    const b = await conn.call({ usd: 0.1, order: 'o1' }, 'shop_tip');

    expect(shop.verbs('INTENT')).toHaveLength(1);
    expect(proposalsOf(b)).toEqual(proposalsOf(a));

    // Another float is another call.
    await conn.call({ order: 'o1', usd: 0.2 }, 'shop_tip');
    expect(shop.verbs('INTENT')).toHaveLength(2);
  });

  it('no grants: the proposals, no codes, and a yea grant hint', async () => {
    const k = await keys();
    const { conn } = await bridged(k, '2026', { caveats: null });
    const r = await conn.call(BIG_ORDER, 'shop_order');

    expect(r.isError).toBe(true);
    expect(proposalsOf(r).codes).toEqual([]);
    expect(textOf(r)).toContain('`yea grant` for this agent');
    expect(textOf(r)).not.toContain('pc1.');
  });

  it('a re-call before approval returns the same codes, and the approval still commits', async () => {
    const k = await keys();
    const { conn, shop } = await bridged(k);
    const first = proposalsOf(await conn.call(BIG_ORDER, 'shop_order'));
    const again = await conn.call(BIG_ORDER, 'shop_order');

    expect(textOf(again)).toMatch(
      /^nothing was run: still waiting for approval/,
    );
    expect(proposalsOf(again)).toEqual(first);
    expect(shop.verbs('INTENT')).toHaveLength(1);

    await conn.call(
      { token: await approveCode(k.principal, first.codes[0].code) },
      'yea_consent',
    );

    const done = await conn.call(BIG_ORDER, 'shop_order');

    expect(textOf(done)).toMatch(/^… authorizing card/);
    expect(textOf(done)).toContain('✓ 4 meals for 2030-01-01 — 49.95 USD');
  });

  it('a consent saved by yea approve on this machine commits without yea_consent', async () => {
    const k = await keys();
    const { conn } = await bridged(k);
    const { proposals, codes } = proposalsOf(
      await conn.call(BIG_ORDER, 'shop_order'),
    );

    saveGrant(
      await approveCode(k.principal, codes[0].code),
      'consents',
      proposals[0].hash,
    );

    expect(textOf(await conn.call(BIG_ORDER, 'shop_order'))).toContain(
      '✓ 4 meals',
    );
  });

  it('an expired pending entry falls back to a fresh INTENT', async () => {
    const k = await keys();
    let now = unixNow();
    const { conn, shop } = await bridged(k, '2026', {
      options: { now: () => now },
    });
    const first = proposalsOf(await conn.call(BIG_ORDER, 'shop_order'));

    // Proposals live 10 minutes; with under 2 left, the entry is dropped.
    now = first.proposals[0].expires - 119;

    const again = await conn.call(BIG_ORDER, 'shop_order');

    // A fresh INTENT, whose proposals (on the moved clock) arrive too close to expiry to offer.
    expect(shop.verbs('INTENT')).toHaveLength(2);
    expect(textOf(again)).toMatch(/expire in under 2 minutes/);
    expect(textOf(again)).not.toContain('pc1.');
  });

  it('a pending proposal the service discarded (expired) falls back to a fresh INTENT', async () => {
    const k = await keys();
    let discard = false;
    const ex = await examples(k);
    const rewritten = recorded(shopService(k), (f, r) =>
      discard && f.verb === 'COMMIT'
        ? {
            yea: 1,
            id: 's',
            re: f.id,
            kind: 'ERROR',
            code: 'expired',
            message: 'proposal expired',
          }
        : r,
    );
    const factory = await bridge([
      { client: await agentClient(k, rewritten.t), url: 'test:shop' },
      ex.clients[0],
    ]);
    const conn = await connect('2026', factory);
    const tip = { order: 'o1', usd: 2.5 };
    const [p] = proposalsOf(await conn.call(tip, 'shop_tip')).proposals;

    discard = true;

    const r = await conn.call({ ...tip, proposal: p.id }, 'shop_tip');

    expect(rewritten.verbs('INTENT')).toHaveLength(2);
    expect(proposalsOf(r).proposals[0].id).not.toBe(p.id);
  });

  it('preview commits nothing and keeps nothing', async () => {
    const k = await keys();
    const { conn, shop } = await bridged(k);
    const r = await conn.call({ ...SMALL_ORDER, preview: true }, 'shop_order');

    expect(textOf(r)).toMatch(/^preview: nothing was run\n2 proposals/);
    expect(shop.verbs('INTENT')[0]).not.toHaveProperty('auto');
    expect(shop.verbs('COMMIT')).toHaveLength(0);

    // Nothing was kept: the real call starts with its own INTENT, and auto-commits.
    expect(textOf(await conn.call(SMALL_ORDER, 'shop_order'))).toMatch(/^✓/);
    expect(shop.verbs('INTENT')).toHaveLength(2);
  });

  it('CLARIFY and service errors come back as Lens', async () => {
    const k = await keys();
    const { conn } = await bridged(k);
    const q = await conn.call({ event: 'Standup' }, 'calendar_reschedule');

    expect(q.isError).toBeFalsy();
    expect(textOf(q)).toMatch(/^\? 3 events match "Standup". Which one\?/);

    const e = await conn.call(
      { event: 'nothing like it' },
      'calendar_reschedule',
    );

    expect(e.isError).toBe(true);
    expect(textOf(e)).toMatch(/^✗ not_found: no event matches/);
  });
});

describe('proposals expire one by one, and only kept ones get codes', () => {
  it('a proposal arriving with under 2 minutes left gets no code and is not kept', async () => {
    const k = await keys();
    const rec = recorded(twoTimes(k, 60, 600));
    const conn = await connect(
      '2026',
      await bridge([await agentClient(k, rec.t)]),
    );
    const r = await conn.call({}, 'lab_pick');
    const { proposals, codes } = proposalsOf(r);

    expect(proposals.map((p) => p.summary)).toEqual(['plan 1']);
    expect(codes.map((c) => c.proposal)).toEqual([proposals[0].id]);
    expect(textOf(r)).toMatch(
      /1 proposal expires in under 2 minutes, so it isn't offered/,
    );
    expect(textOf(r)).not.toContain('plan 0');
  });

  it('every proposal arriving too close to expiry: nothing offered or kept', async () => {
    const k = await keys();
    const rec = recorded(twoTimes(k, 30, 60));
    const conn = await connect(
      '2026',
      await bridge([await agentClient(k, rec.t)]),
    );
    const r = await conn.call({}, 'lab_pick');

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(
      /2 proposals expire in under 2 minutes, so they aren't offered/,
    );
    await conn.call({}, 'lab_pick');
    expect(rec.verbs('INTENT')).toHaveLength(2);
  });

  it('a kept proposal near expiry loses its code, but a saved approval still commits it until it expires', async () => {
    const k = await keys();
    let now = unixNow();
    const rec = recorded(twoTimes(k, 300, 900));
    const conn = await connect(
      '2026',
      await bridge([await agentClient(k, rec.t)], { now: () => now }),
    );
    const first = proposalsOf(await conn.call({}, 'lab_pick'));

    expect(first.codes).toHaveLength(2);
    now = first.proposals[0].expires - 100;

    // No new code for the first; the second still has one.
    const again = await conn.call({}, 'lab_pick');

    expect(rec.verbs('INTENT')).toHaveLength(1);
    expect(proposalsOf(again).codes.map((c) => c.proposal)).toEqual([
      first.proposals[1].id,
    ]);
    expect(textOf(again)).toMatch(
      /1 pending proposal expires in under 2 minutes/,
    );

    // An approval of the first (from its earlier code) is still taken, and commits it.
    const saved = await conn.call(
      { token: await approveCode(k.principal, first.codes[0].code) },
      'yea_consent',
    );

    expect(saved.isError).toBeFalsy();
    expect(textOf(await conn.call({}, 'lab_pick'))).toMatch(/^✓ plan 0/);
  });

  it('once only uncoded proposals are left and none is approved, the call starts over', async () => {
    const k = await keys();
    let now = unixNow();
    const rec = recorded(twoTimes(k, 300, 300));
    const conn = await connect(
      '2026',
      await bridge([await agentClient(k, rec.t)], { now: () => now }),
    );
    const first = proposalsOf(await conn.call({}, 'lab_pick'));

    now = first.proposals[0].expires - 100;
    await conn.call({}, 'lab_pick');
    expect(rec.verbs('INTENT')).toHaveLength(2);
  });
});

describe('a failed consent never wedges the call, and a named proposal is the one acted on', () => {
  it('a consent the service refuses is reported once, then set aside', async () => {
    const k = await keys();
    // The service refuses any COMMIT that carries a consent on top of the agent's grant.
    const rec = recorded(shop({ trust: [k.principal.public] }), (f, r) =>
      f.verb === 'COMMIT' && (f.grants?.length ?? 0) > 1
        ? {
            yea: 1,
            id: 's',
            re: f.id,
            kind: 'ERROR',
            code: 'forbidden',
            message: 'consent not accepted here',
          }
        : r,
    );
    const conn = await connect(
      '2026',
      await bridge([await agentClient(k, rec.t)]),
    );
    const { codes } = proposalsOf(await conn.call(BIG_ORDER, 'shop_order'));
    const token = await approveCode(k.principal, codes[0].code);

    await conn.call({ token }, 'yea_consent');

    const failed = await conn.call(BIG_ORDER, 'shop_order');

    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toMatch(/^✗ forbidden: consent not accepted here/);
    expect(textOf(failed)).toMatch(/won't use it again/);

    const next = await conn.call(BIG_ORDER, 'shop_order');

    expect(textOf(next)).toMatch(
      /^nothing was run: still waiting for approval/,
    );
    expect(rec.verbs('COMMIT')).toHaveLength(1);

    // The same consent again is refused as refused, not saved.
    const again = await conn.call({ token }, 'yea_consent');

    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(
      /refused by the service when it was used; ask the user to approve the code again/,
    );

    // A fresh approval of the same proposal replaces the one that failed.
    const fresh = await approveCode(k.principal, codes[0].code);

    expect(
      (await conn.call({ token: fresh }, 'yea_consent')).isError,
    ).toBeFalsy();
  });

  it('naming proposal B commits B with the grants only, never a consented A', async () => {
    const k = await keys();
    const { conn, shop: rec } = await bridged(k);
    const { proposals, codes } = proposalsOf(
      await conn.call(BIG_ORDER, 'shop_order'),
    );
    const [a, b] = proposals;

    await conn.call(
      { token: await approveCode(k.principal, codes[0].code) },
      'yea_consent',
    );

    const named = await conn.call(
      { ...BIG_ORDER, proposal: b.id },
      'shop_order',
    );

    expect(textOf(named)).toMatch(/needs the user's approval/);
    expect(proposalsOf(named).codes.map((c) => c.proposal)).toEqual([b.id]);
    expect(rec.verbs('COMMIT').map((f) => ('hash' in f ? f.hash : ''))).toEqual(
      [b.hash],
    );
    expect(rec.verbs('COMMIT')[0].grants).toHaveLength(1);

    // Naming A uses A's own consent.
    const done = await conn.call(
      { ...BIG_ORDER, proposal: a.id },
      'shop_order',
    );

    expect(textOf(done)).toContain(`✓ ${a.summary}`);
  });
});

describe('deny', () => {
  it('refuses first, previews included, on the capability name', async () => {
    const k = await keys();

    writePolicy(k, { deny: ['shop.order'] });

    const { conn, shop } = await bridged(k);

    for (const args of [SMALL_ORDER, { ...SMALL_ORDER, preview: true }]) {
      const r = await conn.call(args, 'shop_order');

      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/your policy never allows shop.order/);
    }

    expect(shop.sent.filter((f) => f.verb !== 'HELLO')).toHaveLength(0);
  });

  it('matches service/capability after a suffix, never the tool name', async () => {
    const k = await keys();
    const trust = [k.principal.public];

    writePolicy(k, { deny: ['shop.a/shop.order', 'shop_order'] });

    const a = recorded(shop({ trust, id: 'shop.a' }));
    const b = recorded(shop({ trust, id: 'shop.b' }));
    const factory = await bridge([
      await agentClient(k, a.t),
      await agentClient(k, b.t),
    ]);
    const conn = await connect('2026', factory);
    const { tools } = await conn.client.listTools();
    const names = ['shop.a', 'shop.b'].map(
      (id) =>
        tools.find(
          (t) =>
            t._meta?.['dev.yea/service'] === id &&
            t._meta?.['dev.yea/capability'] === 'shop.order',
        )?.name ?? '',
    );

    expect(names[0]).toMatch(/^shop_order_/);
    expect(textOf(await conn.call(SMALL_ORDER, names[0]))).toMatch(
      /never allows/,
    );
    expect(textOf(await conn.call(SMALL_ORDER, names[1]))).toMatch(/^✓/);
  });
});

describe('a policy file that can not be read refuses job calls', () => {
  it('invalid JSON, or a bad deny, refuses every job call; reads still work', async () => {
    const k = await keys();
    const { conn, shop: rec } = await bridged(k);

    writeFileSync(join(k.home, 'policy.json'), '{"deny": [');

    const r = await conn.call(BIG_ORDER, 'shop_order');

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/policy.json is not valid JSON/);
    expect(
      (await conn.call({ tag: 'vegan' }, 'shop_search')).isError,
    ).toBeFalsy();

    writePolicy(k, { deny: 'shop.order' });
    expect(textOf(await conn.call(BIG_ORDER, 'shop_order'))).toMatch(
      /bad value/,
    );
    expect(rec.verbs('INTENT')).toHaveLength(0);

    // Unknown fields only warn.
    writePolicy(k, { deny: [], note: 'hi' });
    expect(textOf(await conn.call(BIG_ORDER, 'shop_order'))).toMatch(
      /^nothing was run/,
    );
  });
});

describe('utilities', () => {
  it('yea_expand fetches the rest of an elided read', async () => {
    const k = await keys();
    const { conn } = await bridged(k, '2026', { options: { budget: 200 } });
    const r = await conn.call({ tag: 'vegan' }, 'shop_search');
    const handle = /EXPAND (h_[\w-]+)/.exec(textOf(r))?.[1];

    expect(textOf(r)).toContain('call yea_expand with service "shop.example"');
    expect(handle).toBeDefined();

    const more = await conn.call(
      { service: 'shop.example', handle },
      'yea_expand',
    );

    expect(more.isError).toBeFalsy();
    expect(textOf(more)).toMatch(/^items\[/);
  });

  it('yea_undo undoes a receipt; an unknown service is named', async () => {
    const k = await keys();
    const { conn } = await bridged(k);
    const r = await conn.call(SMALL_ORDER, 'shop_order');
    const { receipt } = r.structuredContent as { receipt: { id: string } };
    const undone = await conn.call(
      { service: 'shop.example', receipt: receipt.id },
      'yea_undo',
    );

    expect(undone.isError).toBeFalsy();
    expect(textOf(undone)).toMatch(/^↶ undid/);

    const unknown = await conn.call(
      { service: 'nope', receipt: receipt.id },
      'yea_undo',
    );

    expect(textOf(unknown)).toMatch(
      /unknown service "nope"; known: calendar.example, shop.example/,
    );
  });
});
