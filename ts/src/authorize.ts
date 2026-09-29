/**
 * Authorization for a YEA service (SPEC §6.4, §6.5): verify a request's proof, then find a
 * grant that allows it, or the error that says why none does. Service holds one Authorizer.
 */

import { grantsOf } from './authorize/request-grants.js';
import { consentRequest } from './consent.js';
import { fix, YeaError } from './errors.js';
import { type CheckContext, checkGrant, type GrantCheck } from './grants.js';
import type { ServiceOptions } from './plan.js';
import { autoTarget, checkProof } from './proof.js';
import { ledgerId } from './store.js';
import type { Intent, Proof, Proposal, Request, Verb } from './types.js';

export type Authorized = GrantCheck & { ok: true };

type Failed = GrantCheck & { ok: false };

/**
 * What authorize() found: the authorizing grant (null: anonymous), and the request proof it
 * verified (null: none was checked). Reply fitting and the auto-INTENT replay key read the
 * holder key from `proof` only, never from the request.
 */
export interface Authorization {
  granted: Authorized | null;
  proof: Proof | null;
}

/** What a request is being authorized for. */
export interface AuthScope {
  verb: Verb;
  capability: string;
  /** What the request proof must be signed over. */
  target: string;
  proposal?: Proposal;
  /** Only grants from this principal (the one the proposal was made for) may act. */
  principal?: string | null;
  /** An idempotent COMMIT replay: limits the original commit used up don't block it. */
  replay?: boolean;
}

/** Checks the proofs and grants on requests to one service, against its trust and `total` ledger. */
export class Authorizer {
  readonly id: string;

  constructor(
    private readonly opts: ServiceOptions,
    private readonly now: () => number,
    private readonly used: Map<string, bigint>,
  ) {
    this.id = opts.id;
  }

  /**
   * Verify grants on a request; returns the authorizing check and the verified proof, or throws
   * the right error. No grant means anonymous, which only verbs that don't require one allow.
   */
  async authorize(req: Request, scope: AuthScope): Promise<Authorization> {
    const required =
      scope.verb === 'COMMIT' ||
      scope.verb === 'UNDO' ||
      this.opts.requireGrants;

    if (required) {
      const { granted, proof } = await this.checkRequired(req, scope);

      return { granted, proof };
    }

    if (!grantsOf(req).length) {
      return { granted: null, proof: null };
    }

    // ASK/INTENT don't need a grant here, so a grant that doesn't apply just means "anonymous".
    const { granted, proof } = await this.checkGrants(req, scope);

    return { granted: granted ?? null, proof };
  }

  /** Like authorize(), for a request that must carry a grant: never anonymous. */
  async authorizeRequired(req: Request, scope: AuthScope): Promise<Authorized> {
    return (await this.checkRequired(req, scope)).granted;
  }

  /** The authorizing grant of a request that must carry one, and the proof it was checked with. */
  private async checkRequired(
    req: Request,
    scope: AuthScope,
  ): Promise<{ granted: Authorized; proof: Proof }> {
    if (!grantsOf(req).length) {
      throw new YeaError(
        'unauthorized',
        `${scope.verb} needs a grant from your principal`,
        {
          fix: [
            fix(
              'ask your principal to issue a grant (yea grant) and send it in `grants` with a `proof`',
            ),
          ],
        },
      );
    }

    const { granted, failed, proof } = await this.checkGrants(req, scope);

    if (granted) {
      return { granted, proof };
    }

    throw grantFailure(failed, scope.proposal, this.id);
  }

  /** Verify the proof, then try each grant: the first that authorizes wins; the rest say why not. */
  private async checkGrants(
    req: Request,
    scope: AuthScope,
  ): Promise<{ granted?: Authorized; failed: Failed[]; proof: Proof }> {
    const proof = await this.verifyProof(req.proof, scope.verb, scope.target);
    const failed: Failed[] = [];

    for (const g of grantsOf(req)) {
      const c = await checkGrant(
        g,
        this.grantContext(
          scope.verb,
          scope.capability,
          proof.key,
          scope.proposal,
        ),
      );

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
        return { granted: c, failed, proof };
      }

      // Replaying an already-executed commit must not be blocked by money/risk limits it already used up.
      if (scope.replay && c.code === 'consent_required' && c.iss) {
        return {
          granted: {
            ok: true,
            id: '',
            iss: c.iss,
            holder: proof.key,
            totals: [],
          },
          failed,
          proof,
        };
      }

      failed.push(c);
    }

    return { failed, proof };
  }

  /** Returns the request proof if it is validly signed over this verb and target; throws otherwise. */
  private async verifyProof(
    proof: Proof | undefined,
    verb: Verb,
    target: string,
  ): Promise<Proof> {
    const err = await checkProof(
      proof,
      { aud: this.id, verb, target },
      this.now(),
    );

    if (proof && !err) {
      return proof;
    }

    throw new YeaError('unauthorized', err ?? 'missing proof', {
      fix: [
        fix(
          `sign {aud:"${this.id}",verb:"${verb}",target,ts} with the grant holder key`,
        ),
      ],
    });
  }

  private grantContext(
    verb: Verb,
    capability: string,
    proofKey: string,
    proposal?: Proposal,
  ): CheckContext {
    return {
      service: this.id,
      verb,
      capability,
      now: this.now(),
      trusted: this.opts.trust ?? [],
      proofKey,
      proposal: proposal && {
        hash: proposal.hash,
        uses: proposal.uses,
        risk: proposal.risk,
      },
      used: (id, of) => this.used.get(ledgerId({ block: id, of })) ?? 0n,
    };
  }

  /**
   * Policy-gated auto-commit (SPEC §4.3.1): a grant that authorizes it outright, if it is undoable.
   * When `principal` is set, only a grant from that principal (the proposal's) counts, so the
   * search goes on past a valid grant from another one.
   */
  async autoAuth(
    req: Intent,
    proposal: Proposal,
    principal: string | null,
  ): Promise<Authorized | null> {
    const { proof } = req;
    const grants = grantsOf(req);

    if (!proposal.undo || !grants.length || !proof) {
      return null;
    }

    const target = autoTarget(req.capability, req.id);

    if (
      await checkProof(
        proof,
        { aud: this.id, verb: 'INTENT', target },
        this.now(),
      )
    ) {
      return null;
    }

    for (const g of grants) {
      const c = await checkGrant(
        g,
        this.grantContext('COMMIT', proposal.capability, proof.key, proposal),
      );

      if (c.ok && (principal === null || c.iss === principal)) {
        return c;
      }
    }

    return null;
  }
}

/** The most useful error when no grant authorized: consent, then forbidden, then the first failure. */
function grantFailure(
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
