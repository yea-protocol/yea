// The job call session (src/job-call.ts): what the vectors in conformance/job-calls.json can't
// show, the fallback an ask carries and the errors that refuse a call before anything runs.

import { describe, expect, it } from 'vitest';
import * as P from '../src/index.js';
import { fmtTime } from '../src/lens.js';

const now = 1790000000;
const principal = await P.keyPair();
const server = await P.keyPair();

/** A call outside any policy from a client that can ask, on a store `yea approve` can reach. */
const call = (over: Partial<P.JobCall> = {}): P.JobCall => ({
  tool: { name: 'refund' },
  input: { who: 'Chen' },
  plan: () => [
    { summary: 'Refund', effects: [], risk: 'low', apply: () => null },
  ],
  sub: '',
  now,
  policy: {
    grant: null,
    principal: principal.public,
    server: server.public,
    deny: [],
    outOfBand: 'high',
  },
  canAsk: true,
  ...over,
});

/** A MemoryStore the session doesn't treat as one, so it issues consent codes. */
function fileLike(): P.ApprovalStore {
  const s = new P.MemoryStore();

  return {
    consumeOnce: (id, exp) => s.consumeOnce(id, exp),
    putReceipt: (r) => s.putReceipt(r),
    getReceipt: (id) => s.getReceipt(id),
    claimUndo: (id) => s.claimUndo(id),
    releaseUndo: (id) => s.releaseUndo(id),
    markUndone: (id) => s.markUndone(id),
    reserve: (k, a, m) => s.reserve(k, a, m),
    settle: (r) => s.settle(r),
    release: (r) => s.release(r),
    used: (k) => s.used(k),
    putConsent: (h, g) => s.putConsent(h, g),
    getConsent: (h) => s.getConsent(h),
  };
}

describe('job call session', () => {
  it('an ask carries what to return instead when the client turns out to be unreachable', async () => {
    const o = await P.jobCall(call(), fileLike());

    if (o.kind !== 'ask') {
      throw new Error(o.kind);
    }

    const instead = await o.otherwise();

    expect(instead.kind).toBe('consent-codes');
    expect(instead.why).toBe("refund can't be undone");
    expect(instead.codes.map((c) => c.planHash)).toEqual(o.form.offered);
    expect(instead.unavailable).toBeNull();
  });

  it('a MemoryStore gets no consent codes: yea approve could never reach it', async () => {
    const o = await P.jobCall(call({ canAsk: false }), new P.MemoryStore());

    expect(o.kind === 'consent-codes' && o.unavailable).toMatch(
      /keeps approvals in memory/,
    );
  });

  it('a non-integer input throws before the handler runs', async () => {
    let planned = false;
    const c = call({
      input: { amount: 1.5 },
      plan: () => {
        planned = true;

        return [];
      },
    });

    await expect(P.jobCall(c, new P.MemoryStore())).rejects.toThrow(
      'only hold safe integers',
    );
    expect(planned).toBe(false);
  });

  it('a handler that returns neither plans nor a clarification throws', async () => {
    await expect(
      P.jobCall(call({ plan: () => 'refund' }), new P.MemoryStore()),
    ).rejects.toThrow('plan() must return an array of plans or clarify()');
  });

  it('a phrase no one could type throws before anyone is asked', async () => {
    const c = call({
      tool: { name: 'refund', confirmWith: () => 'go‮' },
    });

    await expect(P.jobCall(c, new P.MemoryStore())).rejects.toThrow(
      'the phrase from confirmWith() has unprintable characters',
    );
  });

  it('a store that fails while consuming a state throws, and nothing runs', async () => {
    const store = fileLike();
    const asked = await P.jobCall(call(), store);

    if (asked.kind !== 'ask') {
      throw new Error(asked.kind);
    }

    store.consumeOnce = () => Promise.reject(new Error('the store is busy'));

    await expect(
      P.jobCall(call(), store, {
        state: asked.state,
        answer: { action: 'accept', content: { confirm: 'approve' } },
      }),
    ).rejects.toThrow('busy');
  });
});

// #405: a signed policy whose `total` counts per week (SPEC.md §6.3, SPEC-approval §5). The plan
// is the flagship's shape (#406): medium risk, an `each`, a weekly `total`, a 60-second undo.
describe('a policy with a weekly total', async () => {
  const WEEK = 7 * 86400;
  const nbf = now - 3 * 86400;
  const usd = (cents: number) => P.quantity(cents, { scale: 2, unit: 'USD' });
  const weekly = await P.issueGrant({
    principal,
    to: server.public,
    iat: nbf,
    caveats: [
      { can: ['buy'] },
      { risk: 'medium' },
      { each: { of: 'spend', max: 30000, scale: 2, unit: 'USD' } },
      {
        total: { of: 'spend', max: 50000, scale: 2, unit: 'USD', every: WEEK },
      },
      { nbf },
      { exp: nbf + 8 * WEEK },
    ],
  });
  const block = await P.sha256(P.decodeGrant(weekly)[0].s);
  const weekOf = (start: number): P.LedgerKey => ({
    block,
    of: 'spend',
    period: { every: WEEK, start },
  });
  const buy = (cents: number, at: number) =>
    call({
      tool: { name: 'buy', revert: () => null },
      input: { cents },
      plan: () => [
        {
          summary: `Buy ${cents / 100} USD`,
          effects: [],
          risk: 'medium',
          uses: { spend: usd(cents) },
          undoWindow: 60,
          apply: () => null,
        },
      ],
      now: at,
      policy: { ...call().policy, grant: weekly },
    });

  /** One call: a run settles what it holds, as the adapter does once the plan applies. */
  async function run(store: P.ApprovalStore, cents: number, at: number) {
    const o = await P.jobCall(buy(cents, at), store);

    if (o.kind === 'run') {
      await Promise.all(o.held.map((h) => store.settle(h)));
    }

    return o;
  }

  it('asks in the week it filled, runs in the next until that fills, and keeps the old week', async () => {
    const store = fileLike();
    const nextWeek = nbf + WEEK;

    expect((await run(store, 30000, now)).kind).toBe('run');

    const asked = await run(store, 30000, now);

    if (asked.kind !== 'ask') {
      throw new Error(asked.kind);
    }

    expect((await asked.otherwise()).why).toBe(
      `spend would pass the total limit of 500.00 USD every 7d (starts again ${fmtTime(nextWeek)})`,
    );

    expect((await run(store, 30000, nextWeek + 60)).kind).toBe('run');
    expect((await run(store, 20000, nextWeek + 120)).kind).toBe('run');
    expect((await run(store, 1, nextWeek + 180)).kind).toBe('ask');
    expect(await store.used(weekOf(nbf))).toBe(P.exact(usd(30000)));
    expect(await store.used(weekOf(nextWeek))).toBe(P.exact(usd(50000)));
  });

  it('a clock in fractional seconds is floored: the run counts in the period of its whole second', async () => {
    const store = fileLike();
    // Half a second before the second week: floored, it is in the first; rounded, in the second.
    const o = await P.jobCall(buy(30000, nbf + WEEK - 0.5), store);

    if (o.kind !== 'run') {
      throw new Error(o.kind);
    }

    expect(o.held.map((h) => h.key)).toEqual([weekOf(nbf)]);
  });

  it('a reservation released after the week ends frees that week only', async () => {
    const store = fileLike();
    const o = await P.jobCall(buy(30000, nbf + WEEK - 1), store);

    if (o.kind !== 'run') {
      throw new Error(o.kind);
    }

    // The plan failed after the boundary: what it held goes back to the week it was taken in.
    await Promise.all(o.held.map((h) => store.release(h)));

    expect(await store.used(weekOf(nbf))).toBe(0n);
    expect(await store.used(weekOf(nbf + WEEK))).toBe(0n);
    expect((await run(store, 30000, nbf + WEEK - 1)).kind).toBe('run');
  });
});
