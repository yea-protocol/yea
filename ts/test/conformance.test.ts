import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as P from '../src/index.js';
import { FileStore } from '../src/node.js';

const DIR = new URL('../../conformance/', import.meta.url);

/** Each vector file this runner loaded, with the top-level sections it read (none for a list). */
const read = new Map<string, Set<string>>();

/** A vector file; reading an object's sections is recorded, so an unread one fails below. */
function load(n: string) {
  const data = JSON.parse(readFileSync(new URL(`${n}.json`, DIR), 'utf8'));
  const seen = read.get(n) ?? new Set<string>();

  read.set(n, seen);

  return Array.isArray(data)
    ? data
    : new Proxy(data, {
        get(target, key, receiver) {
          if (typeof key === 'string') {
            seen.add(key);
          }

          return Reflect.get(target, key, receiver);
        },
      });
}

describe('conformance vectors', () => {
  it('canonical', () => {
    for (const c of load('canonical')) {
      if (c.error) {
        expect(() => P.canonical(c.input), c.name).toThrow();
      } else {
        expect(P.canonical(c.input), c.name).toBe(c.canonical);
      }
    }
  });
  it('canonical rejects floats', () => {
    expect(() => P.canonical({ x: 1.5 })).toThrow();
  });
  it('keys', async () => {
    for (const k of load('keys')) {
      if (k.valid === false) {
        await expect(P.keyPair(k.seed), k.seed).rejects.toThrow();
      } else {
        expect((await P.keyPair(k.seed)).public).toBe(k.public);
      }
    }
  });
  it('hash', async () => {
    for (const h of load('hash')) {
      expect(await P.proposalHash(h.proposal), h.name).toBe(h.hash);
    }
  });
  it('proof', async () => {
    for (const p of load('proof')) {
      if (p.valid === false) {
        expect(
          await P.checkProof({ key: p.key, ts: p.ts, sig: p.sig }, p, p.ts),
        ).not.toBeNull();

        continue;
      }

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
  it("grants: the total block ids and seeds are the cases' own", async () => {
    const { cases, rootTotalBlockId, countsTotalBlockId, seeds } =
      load('grants');
    const ids = new Set<string>();
    // Some cases are malformed on purpose; they have no block ids.
    const blocksOf = (token: string) => {
      try {
        return P.decodeGrant(token);
      } catch {
        return [];
      }
    };

    for (const c of cases) {
      for (const b of blocksOf(c.token)) {
        ids.add(await P.sha256(b.s));
      }
    }

    expect(ids).toContain(rootTotalBlockId);
    expect(ids).toContain(countsTotalBlockId);
    expect(cases[0].trusted).toContain(
      (await P.keyPair(seeds.principal)).public,
    );
  });
  it('protocol consent code', () => {
    const { consentCode: v } = load('grants');
    const code = P.consentCode(v.consent, v.detail, { agent: v.agent });

    expect(code).toBe(v.code);
    expect(P.decodeConsentCode(code)).toMatchObject({ agent: v.agent });
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

    expect(v.keys).toEqual({
      principal: (await P.keyPair(v.seeds.principal)).public,
      server: (await P.keyPair(v.seeds.server)).public,
    });

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
        c.used[k.of] ? P.exact(c.used[k.of]) : 0n;
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

    for (const c of v.phraseChecks) {
      const check = () => P.checkedPhrase(c.phrase);

      if (c.expect === null) {
        expect(check, c.name).toThrow(TypeError);
      } else {
        expect(check(), c.name).toBe(c.expect);
      }
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

    for (const c of v.consents.cases) {
      const r = await P.checkJobConsent(c.grant, {
        hp: asHashed(v.consents.plan),
        policy: { principal: v.keys.principal, server: v.keys.server },
        now: c.now,
      });

      expect(r, c.name).toEqual(c.expect);
    }

    for (const c of v.undo.cases) {
      const s = new P.MemoryStore();

      for (const r of v.undo.receipts) {
        await s.putReceipt(r);
      }

      const call = () =>
        P.undoJob(s, {
          service: v.undo.service,
          id: c.id,
          sub: c.sub,
          now: c.now,
          revert: () => null,
        });

      if (c.undoneBefore) {
        await call();
      }

      const got = await call();

      expect(got.kind === 'undone' ? { kind: 'undone' } : got, c.name).toEqual(
        c.expect,
      );
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
  it('approval FileStore layout', async () => {
    const v = load('approval');
    const dir = mkdtempSync(join(tmpdir(), 'yea-conf-'));
    const store = new FileStore(dir);
    const key = { block: v.policyBlockId, of: 'emails' };
    const r = await store.reserve(key, 5n, 10n);

    await store.consumeOnce('n_1', v.now + 600);

    if (r) {
      await store.settle(r);
    }

    await store.putConsent(v.consents.plan.planHash, 'pg1.example');
    await store.claimUndo('r_AAAAAAAAAAAA');
    await store.markUndone('r_AAAAAAAAAAAA');

    const files: Record<string, string> = {};
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);

        if (statSync(p).isDirectory()) {
          walk(p);
        } else {
          files[relative(dir, p)] = p.endsWith('.claim')
            ? '*'
            : readFileSync(p, 'utf8');
        }
      }
    };

    walk(dir);
    expect(files).toEqual(v.fileStore.files);
  });
  it('estimate', () => {
    for (const c of load('estimate')) {
      expect(P.est(c.text)).toBe(c.est);
    }
  });
  // Last: every vector file is loaded, and every section of one is read.
  it('reads every section of every vector file', () => {
    for (const f of readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
      const n = f.slice(0, -'.json'.length);
      const data = JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
      const sections = Array.isArray(data) ? [] : Object.keys(data).sort();

      expect(read.has(n), `${f} is never loaded`).toBe(true);
      expect([...(read.get(n) ?? [])].sort(), f).toEqual(sections);
    }
  });
});
