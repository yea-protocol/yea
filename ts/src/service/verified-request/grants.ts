/**
 * Checking a request's proof and grants (SPEC §6.4, §6.5, §6.6): verify the proof once, then find
 * the first grant that allows the request, or the error that says why none does.
 */
import { consentRequest, matchesConsent } from '../../consent.js';
import { fix, YeaError } from '../../errors.js';
import {
  type Block,
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
   * Only a consent grant to the proposal (SPEC §6.6) may act; any other grant that would act gets
   * `consent_required`. Set for a proposal with no principal, so `principal` is null (§4.4).
   */
  consentOnly?: boolean;
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
    const c = screen(
      await checkGrant(g, grantContext(state, holder, scope)),
      scope,
      state.id,
    );

    if (c.ok) {
      return { granted: c, failed };
    }

    failed.push(c);
  }

  return { failed };
}

/**
 * A grant's check as the scope sees it at `service`: failed, even where the grant would
 * authorize, when it is from another principal than the proposal's, or isn't the consent the
 * proposal needs.
 */
function screen(c: GrantCheck, scope: Scope, service: string): GrantCheck {
  // Only grants from the principal the proposal was made for can act on it.
  if (scope.principal && c.iss && c.iss !== scope.principal) {
    return {
      ok: false,
      code: 'forbidden',
      reason: "grant is from a different principal than this proposal's",
      iss: c.iss,
    };
  }

  if (c.ok && scope.consentOnly && !isConsent(c.blocks, scope, service)) {
    return {
      ok: false,
      code: 'consent_required',
      reason: 'no grant authorized the INTENT that made this proposal',
      iss: c.iss,
    };
  }

  return c;
}

/**
 * Whether a verified grant is a consent grant to the scope's proposal at `service` (SPEC §6.6):
 * one root block, which its principal signed, with exactly a consent's caveats. A delegated
 * grant never is, so an agent can't turn its own grant into one.
 */
function isConsent(blocks: Block[], { proposal }: Scope, service: string) {
  return (
    proposal !== undefined &&
    blocks.length === 1 &&
    matchesConsent(blocks[0].p.caveats, { ...proposal, service })
  );
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
 * The principal a COMMIT of a proposal with no principal acts for, if it carries a consent: the
 * issuer of its first consent grant to the proposal, checked without limits (SPEC §4.4).
 */
export async function consenter(
  state: Checker,
  grants: string[],
  holder: string,
  proposal: Proposal,
): Promise<string | null> {
  const { granted } = await firstGrant(state, grants, holder, {
    verb: 'COMMIT',
    capability: proposal.capability,
    proposal,
    principal: null,
    consentOnly: true,
    limits: null,
  });

  return granted?.iss ?? null;
}

/**
 * Grant evaluation with the limits included (ADR-0002), for the commit ledger: of the grants
 * from `principal` held by `holder`, the first that admits a COMMIT of the proposal, or the
 * error that says why none does. A null `principal` (no grant authorized the proposal's INTENT)
 * admits only a consent grant to the proposal, from any principal the service trusts (SPEC §4.4).
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
      consentOnly: principal === null,
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
    used: (key) => scope.limits?.(key) ?? 0n,
    limits: scope.limits !== null,
  };
}
