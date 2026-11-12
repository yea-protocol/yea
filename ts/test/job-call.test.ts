// The job call session (src/job-call.ts): what the vectors in conformance/job-calls.json can't
// show, the fallback an ask carries and the errors that refuse a call before anything runs.

import { describe, expect, it } from 'vitest';
import * as P from '../src/index.js';

const now = 1790000000;
const principal = await P.keyPair();
const server = await P.keyPair();

/** A call outside any policy from a client that can ask. */
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

/** A MemoryStore's methods as a plain object, so a test can replace one. */
function storeOf(): P.ApprovalStore {
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
    storeId: () => s.storeId(),
  };
}

describe('job call session', () => {
  it('an ask carries what to return instead when the client turns out to be unreachable', async () => {
    const o = await P.jobCall(call(), storeOf());

    if (o.kind !== 'ask') {
      throw new Error(o.kind);
    }

    const instead = await o.otherwise();

    expect(instead.kind).toBe('consent-codes');
    expect(instead.why).toBe("refund can't be undone");
    expect(instead.codes.map((c) => c.planHash)).toEqual(o.form.offered);
    expect(instead.unavailable).toBeNull();
  });

  it('a MemoryStore gets consent codes too: their consents come back on the call', async () => {
    const o = await P.jobCall(call({ canAsk: false }), new P.MemoryStore());

    expect(o).toMatchObject({ kind: 'consent-codes', unavailable: null });
    expect(o.kind === 'consent-codes' && o.codes).toHaveLength(1);
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
    const store = storeOf();
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
