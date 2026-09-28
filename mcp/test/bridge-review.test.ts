/**
 * Review fixes on the bridge (PR #77): proposals expire one by one and only kept ones get codes;
 * a consent that fails to commit never wedges the call; a named proposal is the one acted on;
 * unservable param names; caps on service text and tool counts; the pending bound; the EXPAND
 * cap; and a policy file that can't be read.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Proposal,
  type Request,
  service,
  type Transport,
  unixNow,
} from '@yea-protocol/sdk';
import { shop } from '@yea-protocol/sdk/examples';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_PENDING,
  type Pending,
  PendingProposals,
} from '../src/bridge/pending.js';
import { MAX_TOOLS_PER_SERVICE } from '../src/bridge/tools.js';
import { bridge } from '../src/bridge.js';
import {
  agentClient,
  approveCode,
  BIG_ORDER,
  bridged,
  type Keys,
  keys,
  proposalsOf,
  recorded,
  writePolicy,
} from './bridge-helpers.js';
import { connect, textOf } from './helpers.js';

afterEach(() => {
  delete process.env.YEA_HOME;
});

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

describe('R1: proposals expire one by one, and only kept ones get codes', () => {
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

describe('R2: a failed consent never wedges the call, and a named proposal is the one acted on', () => {
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

describe('O1–O2: what the bridge serves', () => {
  it("doesn't serve a tool whose param names some model APIs reject, at any depth", async () => {
    const k = await keys();
    const svc = service({
      id: 'odd.example',
      name: 'Odd',
      summary: 's',
      trust: [k.principal.public],
    })
      .ask('odd.space', {
        summary: 'x',
        params: { 'a b': 'string' },
        run: () => 1,
      })
      .ask('odd.nested', {
        summary: 'x',
        params: { items: [{ 'q!': 'int' }] },
        run: () => 1,
      })
      .ask('odd.fine', {
        summary: 'x',
        params: { 'a.b-c_d?': 'string' },
        run: () => 1,
      });
    const factory = await bridge([await agentClient(k, recorded(svc).t)]);

    expect(factory.tools).toEqual(['odd_fine']);
  });

  it('cuts service text to about 300 characters, and serves at most 200 tools a service', async () => {
    const k = await keys();
    let svc = service({
      id: 'wide.example',
      name: 'Wide',
      summary: 'w'.repeat(1000),
      trust: [k.principal.public],
    });

    for (let i = 0; i < MAX_TOOLS_PER_SERVICE + 5; i++) {
      svc = svc.ask(`w.r${i}`, {
        summary: 's'.repeat(1000),
        params: { 'q?': `string — ${'d'.repeat(1000)}` },
        run: () => i,
      });
    }

    const factory = await bridge([await agentClient(k, recorded(svc).t)], {
      tools: 'per-capability',
    });
    const conn = await connect('2026', factory);
    const { tools } = await conn.client.listTools();

    expect(factory.tools).toHaveLength(MAX_TOOLS_PER_SERVICE);
    expect(tools[0].description?.length).toBeLessThan(400);
    expect(JSON.stringify(tools[0].inputSchema).length).toBeLessThan(500);
    expect(factory.instructions.length).toBeLessThan(3000);
  });
});

describe('O5: bounds', () => {
  it('the pending cache keeps at most 256 entries, dropping the oldest', () => {
    const cache = new PendingProposals();
    const p = { id: 'p', expires: unixNow() + 600 } as Proposal;
    const entry = (i: number): Pending => ({
      key: `k${i}`,
      tool: 't',
      service: 's',
      capability: 'c',
      principal: null,
      proposals: [p],
      codes: [],
      refused: new Set(),
    });

    for (let i = 0; i <= MAX_PENDING; i++) {
      cache.set(entry(i));
    }

    expect(cache.size).toBe(MAX_PENDING);
    expect(cache.get('k0', unixNow())).toBeUndefined();
    expect(cache.get(`k${MAX_PENDING}`, unixNow())).toBeDefined();
  });

  it('stops after 64 EXPANDs of a capability list that never ends', async () => {
    const k = await keys();
    const sent: Request[] = [];
    let n = 0;
    const endless: Transport = {
      async request(f) {
        sent.push(f);

        const more = [
          { handle: `h_${n++}`, path: 'capabilities', remaining: 1, est: 1 },
        ];

        return f.verb === 'HELLO'
          ? {
              yea: 1,
              id: 's',
              re: f.id,
              kind: 'BRIEF',
              service: { id: 'endless', name: 'E', summary: '' },
              capabilities: [],
              more,
            }
          : {
              yea: 1,
              id: 's',
              re: f.id,
              kind: 'ANSWER',
              data: { items: [] },
              more,
            };
      },
      close() {},
    };
    const factory = await bridge([
      { client: await agentClient(k, endless), url: 'test:endless' },
    ]);

    expect(sent.filter((f) => f.verb === 'EXPAND')).toHaveLength(64);
    expect(factory.instructions).toMatch(
      /test:endless could not be reached: too many EXPANDs/,
    );
  });
});

describe('O6: a policy file that can not be read refuses job calls', () => {
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
