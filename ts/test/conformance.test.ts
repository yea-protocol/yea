import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as P from '../src/index.js';

const load = (n: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../conformance/${n}.json`, import.meta.url),
      'utf8',
    ),
  );

describe('conformance vectors', () => {
  it('canonical', () => {
    for (const c of load('canonical')) {
      expect(P.canonical(c.input), c.name).toBe(c.canonical);
    }
  });
  it('canonical rejects floats', () => {
    expect(() => P.canonical({ x: 1.5 })).toThrow();
  });
  it('keys', async () => {
    for (const k of load('keys')) {
      expect((await P.keyPair(k.seed)).public).toBe(k.public);
    }
  });
  it('hash', async () => {
    for (const h of load('hash')) {
      expect(await P.proposalHash(h.proposal), h.name).toBe(h.hash);
    }
  });
  it('proof', async () => {
    for (const p of load('proof')) {
      const made = await P.makeProof(p.seed, p, p.ts);

      expect(made.sig).toBe(p.sig);
      expect(
        await P.checkProof({ key: p.key, ts: p.ts, sig: p.sig }, p, p.ts),
      ).toBeNull();
      expect(
        await P.checkProof(
          { key: p.key, ts: p.ts, sig: p.sig },
          { ...p, target: 'other' },
          p.ts,
        ),
      ).not.toBeNull();
    }
  });
  it('grants', async () => {
    const { cases } = load('grants');

    for (const c of cases) {
      const { used, ...ctx } = c.ctx;
      const got = await P.checkGrant(c.token, {
        ...ctx,
        trusted: c.trusted,
        proofKey: c.proofKey,
        used: (id: string, of: string) =>
          P.exact(used?.[id]?.[of] ?? { amount: 0 }),
      });

      expect(
        got.ok ? { ok: true } : { ok: false, code: got.code },
        c.name,
      ).toEqual(c.expect);
    }
  });
  it('lens', () => {
    for (const c of load('lens')) {
      expect(
        c.type === 'value' ? P.lean(c.input) : P.lens(c.input),
        c.name,
      ).toBe(c.lens);
    }
  });
  it('uses', () => {
    const { quantities, wellFormed } = load('uses');

    for (const q of quantities) {
      expect(P.fmtQuantity(q.quantity)).toBe(q.lens);
    }

    for (const w of wellFormed) {
      expect(P.isUses(w.uses), w.name).toBe(w.valid);
    }
  });
  it('approval', async () => {
    const v = load('approval');

    type HP = P.HashedPlan;

    const asHashed = (x: HP): HP => ({
      ...x,
      plan: { ...x.plan, apply: () => null },
    });

    for (const h of v.hash) {
      if (h.error) {
        expect(
          () => P.planPreimage(h.tool.name, h.input, h.plan, 'low'),
          h.name,
        ).toThrow();

        continue;
      }

      const [hp] = await P.hashPlans(h.tool, h.input, [
        { ...h.plan, apply: () => null },
      ]);

      expect([hp.planHash, hp.risk, hp.undoable], h.name).toEqual([
        h.planHash,
        h.risk,
        h.undoable,
      ]);
    }

    for (const c of v.decide) {
      const used = (k: P.LedgerKey) =>
        k.block === v.policyBlockId && c.used[k.of]
          ? P.exact(c.used[k.of])
          : 0n;
      const d = await P.decide(c.plans.map(asHashed), c.policy, used, c.now);
      const got = {
        kind: d.kind,
        ...('why' in d ? { why: d.why } : {}),
        ...(d.kind === 'run'
          ? {
              planHash: d.plan.planHash,
              reserve: d.reserve.map((r) => ({
                key: r.key,
                amount: String(r.amount),
                max: String(r.max),
              })),
            }
          : {}),
      };

      expect(got, c.name).toEqual(c.expect);
    }

    for (const c of v.phrases) {
      expect(P.phraseMatches(c.typed, c.phrase), JSON.stringify(c.typed)).toBe(
        c.match,
      );
    }

    for (const c of v.forms) {
      const f = P.buildForm(
        c.plans.map(asHashed),
        c.why,
        c.policy,
        (hp) => c.phrases[hp.planHash],
      );

      expect(f, c.name).toEqual(c.expect);
    }

    for (const c of v.states) {
      expect(P.checkState(c.state, c.expect) !== null, c.name).toBe(c.valid);
    }

    for (const c of v.judge) {
      const verdict = P.judgeAnswer(c.state, c.answer, {
        recomputed: c.recomputed.map(asHashed),
        policy: c.policy,
        phraseFor: (hp) => c.phrases[hp.planHash],
      });
      const got =
        'plan' in verdict
          ? { ...verdict, plan: verdict.plan.planHash }
          : verdict;

      expect(got, c.name).toEqual(c.expect);
    }

    for (const c of v.tightening) {
      expect(P.readTightening(c.file), c.name).toEqual(c.expect);
    }

    const cc = v.consentCode;

    expect(
      P.jobConsentCode({
        server: cc.server,
        principal: cc.principal,
        input: cc.input,
        hp: asHashed(cc.plan),
        phrase: cc.phrase,
        now: cc.now,
      }),
    ).toBe(cc.code);
  });
  it('estimate', () => {
    for (const c of load('estimate')) {
      expect(P.est(c.text)).toBe(c.est);
    }
  });
});
