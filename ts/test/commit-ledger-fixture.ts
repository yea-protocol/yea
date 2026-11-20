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
    now: () => t,
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
        : { iss, totals: [{ key, max }] };
    },
  };

  return grant;
}

/**
 * Grant evaluation as a service runs it, with the limits (verified-request/grants.ts): the real
 * check of `grant`, held by `holder` and issued by `trusted`, at the time `at` gives.
 */
export function grantAdmit(
  grant: string,
  keys: { holder: string; trusted: string },
  at: () => number,
): Admit {
  return async (proposal, used) => {
    const r = await P.checkGrant(grant, {
      service: 'pay',
      verb: 'COMMIT',
      capability: proposal.capability,
      now: at(),
      proposal: {
        hash: proposal.hash,
        uses: proposal.uses,
        risk: proposal.risk,
      },
      trusted: [keys.trusted],
      proofKey: keys.holder,
      used,
    });

    return r.ok
      ? { iss: r.iss, totals: r.totals }
      : new P.YeaError(r.code, r.reason);
  };
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
