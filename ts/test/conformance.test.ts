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
  it('estimate', () => {
    for (const c of load('estimate')) {
      expect(P.est(c.text)).toBe(c.est);
    }
  });
});
