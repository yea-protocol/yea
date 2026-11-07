/**
 * Runs one case of ../conformance/commit-ledger.json through a CommitLedger and returns what its
 * COMMIT got, as the vectors record it: the outcome (`RECEIPT`, `replay` or an error code) and
 * whether grant evaluation ran. The generator (commit-ledger-vectors.mjs) and the TS conformance
 * test share it; python/tests/test_commit_ledger_conformance.py is its Python twin.
 *
 * The scene: alice's agent has a proposal to pay 10 cents, expiring 600s from now, under a grant
 * with a `total` of 100 cents. `committed` commits it first; `full` first commits another
 * proposal that takes the whole 100; `late` moves the clock to its expiry. Then `by` commits it,
 * with grant evaluation that answers `admit` whatever the usage ledger holds.
 */

const T0 = 1790000000;
const TOTAL = { id: 'b_1', of: 'spend', max: 10n ** 18n }; // 100 cents, exact at scale 18

/** A COMMIT's outcome as the vectors record it. */
const outcomeOf = (out) =>
  out.kind === 'RECEIPT' ? (out.replay ? 'replay' : 'RECEIPT') : out.code;

export async function runCase({ CommitLedger, YeaError }, c) {
  let t = T0;
  const ledger = new CommitLedger({
    id: 'pay',
    opts: { id: 'pay', name: 'Pay', summary: 'pay' },
    now: () => t,
  });
  const propose = (id, cents) => {
    const stored = {
      proposal: {
        id,
        capability: 'pay.send',
        summary: `pay ${cents}`,
        effects: [{ op: 'create', target: `payment/${id}` }],
        uses: { spend: { amount: cents, scale: 2, unit: 'USD' } },
        risk: 'low',
        undo: null,
        expires: t + 600,
        hash: `h_${id}`,
      },
      plan: { summary: 'pay', effects: [], apply: () => null },
      principal: 'alice',
      requester: 'agent',
      created: t,
    };

    ledger.propose([stored]);

    return stored;
  };
  const commit = (stored, principal, admit) =>
    ledger.commit(
      { id: `c_${stored.proposal.id}`, stored, principal, admit },
      () => undefined,
    );
  const admits = async () => ({ iss: 'alice', totals: [TOTAL] });
  const p = propose('p_1', 10);

  if (c.committed) {
    await commit(p, 'alice', admits);
  }

  if (c.full) {
    await commit(propose('p_2', 100), 'alice', admits);
  }

  if (c.late) {
    t = p.proposal.expires;
  }

  let evaluated = false;
  const admit = async () => {
    evaluated = true;

    return c.admit === 'admits'
      ? { iss: c.by, totals: [TOTAL] }
      : new YeaError(c.admit, 'grant evaluation refused it');
  };

  try {
    return { outcome: outcomeOf(await commit(p, c.by, admit)), evaluated };
  } catch (e) {
    if (!(e instanceof YeaError)) {
      throw e;
    }

    return { outcome: e.code, evaluated };
  }
}
