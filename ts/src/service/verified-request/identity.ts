/**
 * Who is acting, and for whom: a request's verified holder key and the principal of the grant
 * that lets it act, checked without the `each`, `total` and `risk` limits (ADR-0002).
 */
import type { Proof } from '../../types.js';
import {
  type Checker,
  firstGrant,
  grantFailure,
  needsGrant,
  type Scope,
  verifyProof,
} from './grants.js';

/** What a request signs with: its grants and its proof, as parsed. */
export interface Credentials {
  grants: string[];
  proof: Proof | null;
}

/**
 * `holder`: the key of the verified proof, or null when the request carried no grants.
 * `principal`: the issuer of the grant that authorized it, or null (anonymous).
 */
export interface Identity {
  holder: string | null;
  principal: string | null;
  /** The verified proof, or null: the only proof anything after this reads. */
  proof: Proof | null;
}

/** What identity is checked for: the scope, without limits, and the proof target (SPEC §6.5). */
export type IdentityScope = Omit<Scope, 'limits'> & { target: string };

/**
 * The identity of an ASK or INTENT: anonymous is allowed unless the service requires grants. A
 * grant that doesn't apply then means anonymous, but its proof is still verified, and its key is
 * the holder.
 */
export async function identify(
  state: Checker,
  req: Credentials,
  scope: IdentityScope,
): Promise<Identity> {
  if (state.opts.requireGrants) {
    return identifyRequired(state, req, scope);
  }

  if (!req.grants.length) {
    return { holder: null, principal: null, proof: null };
  }

  const proof = await verifyProof(state, req.proof, scope.verb, scope.target);
  const { granted } = await firstGrant(state, req.grants, proof.key, {
    ...scope,
    limits: null,
  });

  return { holder: proof.key, principal: granted?.iss ?? null, proof };
}

/** The identity of a request that must carry a grant: never anonymous. */
export async function identifyRequired(
  state: Checker,
  req: Credentials,
  scope: IdentityScope,
): Promise<{ holder: string; principal: string; proof: Proof }> {
  if (!req.grants.length) {
    throw needsGrant(scope.verb);
  }

  const proof = await verifyProof(state, req.proof, scope.verb, scope.target);
  const { granted, failed } = await firstGrant(state, req.grants, proof.key, {
    ...scope,
    limits: null,
  });

  if (!granted) {
    throw grantFailure(failed, scope.proposal, state.id);
  }

  return { holder: proof.key, principal: granted.iss, proof };
}
