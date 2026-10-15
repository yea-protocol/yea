// The commit ledger (service/commit-ledger.ts) at its interface: replays, limits, expiry, sweep,
// undo and auto-commit, with no keys, proofs or sleeps; and the COMMIT and UNDO handlers that fit
// its receipts to the budget. Its security cases ([H2], [U5], [U5b]) are in security.test.ts.
import { describe, expect, it } from 'vitest';
import { replyFrame } from '../src/frames.js';
import * as P from '../src/index.js';
import { onCommit } from '../src/service/commit.js';
import { onUndo } from '../src/service/undo.js';
import type { FinalReply, More } from '../src/types.js';
import {
  codeOf,
  commitOf,
  deferred,
  ledgerFixture,
  totalGrant,
} from './commit-ledger-fixture.js';

const noEvents = () => undefined;
const DAY = 86_400;

describe('commit replays', () => {
  it('replays a receipt to its principal only', async () => {
    const { ledger, propose } = ledgerFixture();
    const grant = totalGrant(100);
    const p = propose(10);
    const first = await ledger.commit(commitOf(p, grant.admit), noEvents);
    const again = await ledger.commit(commitOf(p, grant.admit), noEvents);

    expect(again.kind === 'RECEIPT' && [again.replay, again.receipt]).toEqual([
      true,
      first.kind === 'RECEIPT' && first.receipt,
    ]);
    expect(
      await codeOf(
        ledger.commit(
          commitOf(p, totalGrant(100, 'eve').admit, 'eve'),
          noEvents,
        ),
      ),
    ).toBe('forbidden');
  });

  it('replays a commit after its limit filled, with no limit evaluated again (§4.4)', async () => {
    const { ledger, propose, advance } = ledgerFixture();
    const grant = totalGrant(60);
    const p = propose(60);

    expect((await ledger.commit(commitOf(p, grant.admit), noEvents)).kind).toBe(
      'RECEIPT',
    );

    // Past its expiry, too: the commit already happened.
    advance(3600);

    const again = await ledger.commit(commitOf(p, grant.admit), noEvents);

    expect(again.kind === 'RECEIPT' && again.replay).toBe(true);
    expect(grant.calls).toBe(1);
    expect(
      await codeOf(ledger.commit(commitOf(propose(1), grant.admit), noEvents)),
    ).toBe('consent_required');
  });
});

describe('a new commit', () => {
  it('throws the error grant evaluation gives, and runs nothing', async () => {
    const { ledger, propose } = ledgerFixture();
    let runs = 0;
    const p = propose(10, { apply: () => runs++ });
    const refuse = () =>
      Promise.resolve(new P.YeaError('forbidden', 'grant does not cover it'));

    expect(await codeOf(ledger.commit(commitOf(p, refuse), noEvents))).toBe(
      'forbidden',
    );
    expect(runs).toBe(0);
  });

  it('refuses an expired proposal', async () => {
    const { ledger, propose, advance } = ledgerFixture();
    const p = propose(10);

    advance(600);

    expect(
      await codeOf(ledger.commit(commitOf(p, totalGrant(100).admit), noEvents)),
    ).toBe('expired');
  });

  it('settles the spend of a commit that applied', async () => {
    const { ledger, propose } = ledgerFixture();
    const grant = totalGrant(100);
    const commit = (cents: number) =>
      codeOf(ledger.commit(commitOf(propose(cents), grant.admit), noEvents));

    expect(await commit(70)).toBe('ok');
    expect(await commit(31)).toBe('consent_required');
    expect(await commit(30)).toBe('ok');
  });

  it('sends the plan’s progress as EVENTs on the frame it answers', async () => {
    const { ledger, propose } = ledgerFixture();
    const events: P.Event[] = [];
    const p = propose(10, {
      apply: ({ progress }) => progress('charging', 0.5),
    });

    await ledger.commit(commitOf(p, totalGrant(100).admit), (e) =>
      events.push(e),
    );

    expect(events.map((e) => [e.re, e.message, e.progress])).toEqual([
      [`c_${p.proposal.id}`, 'charging', 0.5],
    ]);
  });
});

describe('sweep', () => {
  it('keeps a proposal while its commit is in flight, and forgets it a day after its receipt', async () => {
    const { ledger, propose, advance } = ledgerFixture();
    const started = deferred();
    const held = deferred();
    const p = propose(10, {
      apply: () => {
        started.resolve();

        return held.promise;
      },
    });
    const run = ledger.commit(commitOf(p, totalGrant(100).admit), noEvents);

    await started.promise;
    advance(2 * 3600);
    ledger.sweep();
    expect(ledger.proposal(p.proposal.id)).toBe(p);

    held.resolve();

    const out = await run;
    const id = out.kind === 'RECEIPT' ? out.receipt.id : '';

    ledger.sweep();
    expect(ledger.receipt(id)?.principal).toBe('alice');

    advance(DAY + 1);
    ledger.sweep();
    expect([ledger.proposal(p.proposal.id), ledger.receipt(id)]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('forgets an expired proposal no one committed, an hour after it expires', () => {
    const { ledger, propose, advance } = ledgerFixture();
    const p = propose(10);

    advance(600 + 3600);
    ledger.sweep();
    expect(ledger.proposal(p.proposal.id)).toBe(p);

    advance(1);
    ledger.sweep();
    expect(ledger.proposal(p.proposal.id)).toBeUndefined();
  });
});

describe('undo', () => {
  /** A receipt for an undoable payment, and how many times its revert ran. */
  async function receipted(revert: () => unknown = () => null) {
    const f = ledgerFixture();
    const reverts = { n: 0 };
    const p = f.propose(10, {
      revert: () => {
        reverts.n++;

        return revert();
      },
    });
    const out = await f.ledger.commit(
      commitOf(p, totalGrant(100).admit),
      noEvents,
    );
    const stored = f.ledger.receipt(
      out.kind === 'RECEIPT' ? out.receipt.id : '',
    );

    if (!stored) {
      throw new Error('no receipt');
    }

    const undo = () =>
      f.ledger.undo({ id: 'u1', stored, principal: 'alice' }, noEvents);

    return { ...f, reverts, stored, undo };
  }

  it('reverts once when two UNDOs race, and replays the reversal', async () => {
    const held = deferred();
    const { reverts, stored, undo } = await receipted(() => held.promise);
    const both = Promise.all([undo(), undo()]);

    held.resolve();

    const [u1, u2] = await both;

    expect(reverts.n).toBe(1);
    expect(
      [u1, u2].map(
        (u) => u.kind === 'RECEIPT' && [u.receipt.undoes, !!u.replay],
      ),
    ).toEqual([
      [stored.receipt.id, false],
      [stored.receipt.id, true],
    ]);
  });

  it('retries a revert that failed', async () => {
    let fail = true;
    const { reverts, undo } = await receipted(() => {
      if (fail) {
        fail = false;

        throw new Error('bank down');
      }
    });

    expect((await undo()).kind).toBe('ERROR');
    expect((await undo()).kind).toBe('RECEIPT');
    expect(reverts.n).toBe(2);
  });

  it('refuses once the undo window closes, and for a plan with no revert', async () => {
    const { undo, advance } = await receipted();

    advance(601);
    expect(await codeOf(undo())).toBe('expired');

    const { ledger, propose } = ledgerFixture();
    const out = await ledger.commit(
      commitOf(propose(10), totalGrant(100).admit),
      noEvents,
    );
    const stored = ledger.receipt(out.kind === 'RECEIPT' ? out.receipt.id : '');

    expect(
      stored &&
        (await codeOf(
          ledger.undo({ id: 'u1', stored, principal: 'alice' }, noEvents),
        )),
    ).toBe('forbidden');
  });
});

describe('auto-commit (§4.3.1)', () => {
  const answer = { re: 'i1', emit: noEvents };

  it('commits an undoable proposal its grant admits', async () => {
    const { ledger, propose } = ledgerFixture();
    const p = propose(10, { revert: () => null });
    const out = await ledger.autoCommit(p, totalGrant(100).admit, answer);

    expect(out?.kind === 'RECEIPT' && out.receipt.proposal).toBe(p.proposal.id);
  });

  it('leaves a proposal when it is irreversible, has no undo window, or its grant refuses', async () => {
    const { ledger, propose } = ledgerFixture();
    const grant = totalGrant(5);

    expect(await ledger.autoCommit(propose(1), grant.admit, answer)).toBeNull();
    expect(
      await ledger.autoCommit(
        propose(1, { revert: () => null, undoWindow: 0 }),
        grant.admit,
        answer,
      ),
    ).toBeNull();
    expect(grant.calls).toBe(0);
    expect(
      await ledger.autoCommit(
        propose(10, { revert: () => null }),
        grant.admit,
        answer,
      ),
    ).toBeNull();
  });

  it('leaves a proposal when a commit in flight took the room under its total', async () => {
    const { ledger, propose } = ledgerFixture();
    const grant = totalGrant(100);
    const [a, b] = [
      propose(60, { revert: () => null }),
      propose(60, { revert: () => null }),
    ];
    const [ra, rb] = await Promise.all([
      ledger.commit(commitOf(a, grant.admit), noEvents),
      ledger.autoCommit(b, grant.admit, answer),
    ]);

    expect([ra.kind, rb]).toEqual(['RECEIPT', null]);
  });
});

describe('auto INTENT replays (§4.3.1)', () => {
  it('answers a repeat with the original reply, as a new frame, until 900s past the proof', async () => {
    const { ledger, advance } = ledgerFixture();
    const replay = { key: 'agent:f1', proofTs: 1_790_000_000 };
    let answers = 0;
    const answer = (): Promise<FinalReply> => {
      answers++;

      return Promise.resolve(replyFrame('f1', 'ANSWER', { data: answers }));
    };
    const first = await ledger.answerOnce(replay, 'f1', answer);
    const again = await ledger.answerOnce(replay, 'f1b', answer);

    expect(answers).toBe(1);
    expect([again.kind === 'ANSWER' && again.data, again.re]).toEqual([
      1,
      'f1b',
    ]);
    expect(again.id).not.toBe(first.id);

    advance(900);
    await ledger.answerOnce(replay, 'f1c', answer);
    expect(answers).toBe(2);
  });
});

// #279: a replay used to skip `fit`, so it carried the whole receipt whatever budget the repeat
// asked for. SPEC §8: a service SHOULD fit every reply to its request's budget.
describe('replies fit the budget (§8)', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `ledger line ${i}`);
  const moreOf = (r: FinalReply) => ('more' in r ? (r.more as More[]) : []);

  /** A receipted payment whose result is long, and its COMMIT and UNDO handlers with a budget. */
  async function receipted() {
    const { ledger, propose } = ledgerFixture();
    const handles = new P.MemoryHandleStore();
    const state = { ledger, handles };
    const p = propose(10, { apply: () => ({ lines }), revert: () => null });
    const admit = totalGrant(100).admit;
    const commit = (budget: number) =>
      onCommit(
        state,
        { ...commitOf(p, admit), verb: 'COMMIT', budget, holder: 'agent' },
        noEvents,
      );
    const first = await commit(100_000);
    const stored = ledger.receipt(
      first.kind === 'RECEIPT' ? first.receipt.id : '',
    );

    if (!stored) {
      throw new Error('no receipt');
    }

    const undo = (budget: number) =>
      onUndo(
        state,
        {
          verb: 'UNDO',
          id: 'u1',
          budget,
          stored,
          holder: 'agent',
          principal: 'alice',
        },
        noEvents,
      );

    return { first, commit, undo, handles };
  }

  it('fits a COMMIT replay to the repeat’s budget, parking the rest for the holder', async () => {
    const { first, commit, handles } = await receipted();
    const replay = await commit(60);

    expect(first.kind === 'RECEIPT' && first.receipt.result).toEqual({ lines });
    expect(moreOf(first)).toEqual([]);
    expect(replay.kind === 'RECEIPT' && replay.replay).toBe(true);
    expect(replay.kind === 'RECEIPT' && replay.receipt.result).not.toEqual({
      lines,
    });

    const [more] = moreOf(replay);

    expect(handles.get(more?.handle ?? '')?.owner).toBe('agent');
  });

  it('fits an UNDO replay too; a reversal has no result to cut, so it stays whole', async () => {
    const { undo } = await receipted();
    const reversal = await undo(100_000);
    const replay = await undo(1);

    expect(replay.kind === 'RECEIPT' && replay.replay).toBe(true);
    expect(
      replay.kind === 'RECEIPT' &&
        reversal.kind === 'RECEIPT' && [replay.receipt, moreOf(replay)],
    ).toEqual([reversal.kind === 'RECEIPT' && reversal.receipt, []]);
  });
});
