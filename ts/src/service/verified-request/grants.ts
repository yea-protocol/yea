/**
 * Checking a request's proof and grants (SPEC §6.4, §6.5, §6.6): verify the proof once, then find
 * the first grant that allows the request, or the error that says why none does.
 */
import { consentRequest } from '../../consent.js';
import { fix, YeaError } from '../../errors.js';
import {
  type CheckContext,
  checkGrant,
  type GrantCheck,
} from '../../grants.js';
import { checkProof } from '../../proof.js';
import type { Proof, Proposal, Verb } from '../../types.js';
import type { Admit, Used } from '../commit-ledger.js';
import type { ServiceState } from '../state.js';

type Authorized = GrantCheck & { ok: true };

type Failed = GrantCheck & { ok: false };

/** What a grant check reads of the service: its id, trust and clock. */
export type Checker = Pick<ServiceState, 'id' | 'opts' | 'now'>;

/** What a request is checked for. */
export interface Scope {
  verb: Verb;
  capability: string;
  proposal?: Proposal;
  /** Only grants from this principal (the one the proposal was made for) may act. */
  principal?: string | null;
  /**
   * The usage ledger `total` counts against, to check `each`, `total` and `risk` too; null
   * checks who may act only, and those three never deny (ADR-0002).
   */
  limits: Used | null;
}

/** The request proof, if it is validly signed over this verb and target; throws otherwise. */
export async function verifyProof(
  state: Checker,
  proof: Proof | null,
  verb: Verb,
  target: string,
): Promise<Proof> {
  const err = await checkProof(
    proof ?? undefined,
    { aud: state.id, verb, target },
    state.now(),
  );

  if (proof && !err) {
    return proof;
  }

  throw new YeaError('unauthorized', err ?? 'missing proof', {
    fix: [
      fix(
        `sign {aud:"${state.id}",verb:"${verb}",target,ts} with the grant holder key`,
      ),
    ],
  });
}

/** Try each grant against a proof key already verified: the first that authorizes wins; the rest say why not. */
export async function firstGrant(
  state: Checker,
  grants: string[],
  holder: string,
  scope: Scope,
): Promise<{ granted?: Authorized; failed: Failed[] }> {
  const failed: Failed[] = [];

  for (const g of grants) {
    const c = await checkGrant(g, grantContext(state, holder, scope));

    // Only grants from the principal the proposal was made for can act on it.
    if (scope.principal && c.iss && c.iss !== scope.principal) {
      failed.push({
        ok: false,
        code: 'forbidden',
        reason: "grant is from a different principal than this proposal's",
        iss: c.iss,
      });

      continue;
    }

    if (c.ok) {
      return { granted: c, failed };
    }

    failed.push(c);
  }

  return { failed };
}

/** `unauthorized`: a verb that must carry a grant came without one. */
export const needsGrant = (verb: Verb) =>
  new YeaError('unauthorized', `${verb} needs a grant from your principal`, {
    fix: [
      fix(
        'ask your principal to issue a grant (yea grant) and send it in `grants` with a `proof`',
      ),
    ],
  });

/** The most useful error when no grant authorized: consent, then forbidden, then the first failure. */
export function grantFailure(
  failed: Failed[],
  proposal: Proposal | undefined,
  service: string,
): YeaError {
  const consent = failed.find((c) => c.code === 'consent_required');

  if (consent?.iss && proposal) {
    return new YeaError(
      'consent_required',
      `${consent.reason}; your principal must approve this exact proposal`,
      { consent: consentRequest(proposal, service, consent.iss) },
    );
  }

  const forbidden = failed.find((c) => c.code === 'forbidden');

  if (forbidden) {
    return new YeaError('forbidden', forbidden.reason, {
      need: forbidden.need,
    });
  }

  return new YeaError('unauthorized', failed[0].reason);
}

/**
 * Grant evaluation with the limits included (ADR-0002), for the commit ledger: of the grants
 * from `principal` held by `holder`, the first that admits a COMMIT of the proposal, or the
 * error that says why none does.
 */
export const admitter =
  (
    state: Checker,
    grants: string[],
    holder: string,
    principal: string | null,
  ): Admit =>
  async (proposal, used) => {
    const { granted, failed } = await firstGrant(state, grants, holder, {
      verb: 'COMMIT',
      capability: proposal.capability,
      proposal,
      principal,
      limits: used,
    });

    return granted ?? grantFailure(failed, proposal, state.id);
  };

function grantContext(
  state: Checker,
  proofKey: string,
  scope: Scope,
): CheckContext {
  const { proposal } = scope;

  return {
    service: state.id,
    verb: scope.verb,
    capability: scope.capability,
    now: state.now(),
    trusted: state.opts.trust ?? [],
    proofKey,
    proposal: proposal && {
      hash: proposal.hash,
      uses: proposal.uses,
      risk: proposal.risk,
    },
    used: (block, of) => scope.limits?.({ block, of }) ?? 0n,
    limits: scope.limits !== null,
  };
}
