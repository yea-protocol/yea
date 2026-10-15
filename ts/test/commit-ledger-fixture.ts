// A commit ledger with no service around it, for tests at its interface: no keys, no proofs and
// no sleeps. Grant evaluation is a stand-in that judges one `total` as the caveat rule does.
import * as P from '../src/index.js';
import type { Plan, ServiceOptions } from '../src/plan.js';
import {
  type Admit,
  type Admitted,
  type Commit,
  CommitLedger,
  type StoredProposal,
  type Used,
} from '../src/service/commit-ledger.js';
import type { Proposal } from '../src/types.js';
import { exact } from '../src/uses.js';

const T0 = 1_790_000_000;

/** A promise settled from outside: an apply or revert held in flight. */
export function deferred<T = void>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/** A ledger on a clock the test moves, and proposals to pay `cents` made for alice by her agent. */
export function ledgerFixture(opts: Partial<ServiceOptions> = {}) {
  let t = T0;
  const ledger = new CommitLedger({
    id: 'pay',
    opts: { id: 'pay', name: 'Pay', summary: 'pay', ...opts },
    now: () => t,
  });
  let n = 0;

  return {
    ledger,
    advance: (seconds: number) => {
      t += seconds;
    },
    propose(cents: number, plan: Partial<Plan> = {}): StoredProposal {
      const id = `p_${++n}`;
      const stored: StoredProposal = {
        proposal: {
          id,
          capability: 'pay.send',
          summary: `pay ${cents}`,
          effects: [P.create(`payment/${id}`)],
          uses: { spend: P.quantity(cents, { scale: 2, unit: 'USD' }) },
          risk: 'low',
          undo: plan.revert ? { window: plan.undoWindow ?? 600 } : null,
          expires: t + 600,
          hash: `h_${id}`,
        },
        plan: { summary: 'pay', effects: [], apply: () => null, ...plan },
        principal: 'alice',
        requester: 'agent',
        created: t,
      };

      ledger.propose([stored]);

      return stored;
    },
  };
}

/**
 * Grant evaluation for a grant from `iss` with a `total` of `maxCents` on spend: past what the
 * usage ledger holds, it needs consent. `calls` counts the evaluations.
 */
export function totalGrant(maxCents: number, iss = 'alice') {
  const max = exact({ amount: maxCents, scale: 2 });
  const key = { block: 'b_1', of: 'spend' };
  const grant = {
    calls: 0,
    admit: async (
      proposal: Proposal,
      used: Used,
    ): Promise<Admitted | P.YeaError> => {
      grant.calls++;

      const q = proposal.uses?.spend;

      return q && used(key) + exact(q) > max
        ? new P.YeaError('consent_required', 'spend would pass the total limit')
        : { iss, totals: [{ id: key.block, of: key.of, max }] };
    },
  };

  return grant;
}

/** A COMMIT of `stored` by `principal`'s agent, under `admit`. */
export const commitOf = (
  stored: StoredProposal,
  admit: Admit,
  principal = 'alice',
): Commit => ({ id: `c_${stored.proposal.id}`, stored, principal, admit });

/** The error code a ledger call throws, or `ok`. */
export const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof P.YeaError ? e.code : String(e)),
  );
