/**
 * Verifying a parsed request for its verb: find what it names (a capability, proposal, receipt
 * or handle), then check who sent it and whether they may act on that (SPEC §4, §6).
 */
import type { Parked } from '../../budget.js';
import { fix, YeaError } from '../../errors.js';
import { autoTarget, checkProof } from '../../proof.js';
import type { Proposal } from '../../types.js';
import { validateParams } from '../../validate.js';
import { unknownCapability } from '../capabilities.js';
import type { ServiceState, StoredProposal, StoredReceipt } from '../state.js';
import { type Authorized, firstGrant } from './grants.js';
import {
  type Identity,
  identify,
  identifyRequired,
  withLimits,
} from './identity.js';
import type { ParsedRequest } from './parse.js';

/** What verifying a request reads of the service. */
export type Verifier = Pick<
  ServiceState,
  | 'id'
  | 'opts'
  | 'now'
  | 'used'
  | 'asks'
  | 'intents'
  | 'proposals'
  | 'receipts'
  | 'handles'
>;

type Parsed<V extends ParsedRequest['verb']> = ParsedRequest & { verb: V };

/** An auto INTENT (SPEC §4.3.1): its replay key, and the grant that commits its proposal outright. */
export interface AutoCommit {
  /** The verified holder key and frame id, and the proof's `ts`; null with no verified proof. */
  replay: { key: string; proofTs: number } | null;
  /** A grant that authorizes COMMIT of `proposal` with no consent, if it is undoable; else null. */
  grant(proposal: Proposal): Promise<Authorized | null>;
}

/** The capability a request names, registered under `defs`; throws `unknown_capability` otherwise. */
function lookup<D>(
  state: Verifier,
  defs: Map<string, D>,
  name: string | null,
  kind: 'ask' | 'intent',
): { capability: string; def: D } {
  const def = name === null ? undefined : defs.get(name);

  return name !== null && def !== undefined
    ? { capability: name, def }
    : unknownCapability(state, name, kind);
}

export async function verifyAsk(state: Verifier, req: Parsed<'ASK'>) {
  const { capability, def } = lookup(state, state.asks, req.capability, 'ask');

  validateParams(def.params, req.params);

  const { holder, principal } = await identify(state, req, {
    verb: 'ASK',
    capability,
    target: capability,
  });

  return { capability, def, params: req.params, holder, principal };
}

export async function verifyIntent(state: Verifier, req: Parsed<'INTENT'>) {
  const { capability, def } = lookup(
    state,
    state.intents,
    req.capability,
    'intent',
  );

  validateParams(def.params, req.params);

  const who = await identify(state, req, {
    verb: 'INTENT',
    capability,
    target: req.auto ? autoTarget(capability, req.id) : capability,
  });

  return {
    capability,
    def,
    params: req.params,
    goal: req.goal,
    holder: who.holder,
    principal: who.principal,
    auto: req.auto ? autoCommit(state, req, who) : null,
  };
}

/**
 * The auto-commit check of an INTENT whose identity was verified against the auto target. Only
 * that proof's key is ever a replay key: an unverified one would let anyone claim a replay.
 */
function autoCommit(
  state: Verifier,
  req: Parsed<'INTENT'>,
  { holder, principal, proof }: Identity,
): AutoCommit {
  return {
    replay: proof && { key: `${proof.key}:${req.id}`, proofTs: proof.ts },
    grant: async (proposal) => {
      if (!proposal.undo || !holder) {
        return null;
      }

      // Only a grant from the proposal's principal counts, so the search goes on past a valid
      // grant from another one.
      const { granted } = await firstGrant(state, req.grants, holder, {
        verb: 'COMMIT',
        capability: proposal.capability,
        proposal,
        principal,
        limits: true,
      });

      return granted ?? null;
    },
  };
}

export async function verifyCommit(state: Verifier, req: Parsed<'COMMIT'>) {
  const stored =
    req.proposal === null ? undefined : state.proposals.get(req.proposal);

  if (!stored) {
    throw new YeaError(
      'not_found',
      `no proposal ${JSON.stringify(req.proposal)}`,
      {
        fix: [fix('send INTENT again to get fresh proposals')],
      },
    );
  }

  const { proposal } = stored;

  if (req.hash !== proposal.hash) {
    throw new YeaError(
      'conflict',
      'hash does not match the proposal; you would commit something other than what you saw',
      { fix: [fix('re-read the proposal, or send INTENT again')] },
    );
  }

  const scope = {
    verb: 'COMMIT' as const,
    capability: proposal.capability,
    proposal,
    principal: stored.principal,
  };
  const { holder, principal } = await identifyRequired(state, req, {
    ...scope,
    target: proposal.hash,
  });

  checkRequester(stored, holder);

  return {
    stored,
    holder,
    principal,
    limits: () => withLimits(state, req.grants, holder, scope),
  };
}

/** Only the agent that asked for a proposal (with a verified proof) may commit it (SPEC §4.4). */
function checkRequester(stored: StoredProposal, holder: string) {
  if (!stored.requester) {
    throw new YeaError(
      'forbidden',
      "this proposal came from an anonymous INTENT and can't be committed",
      {
        fix: [
          fix('send INTENT again with your grant, then commit that proposal'),
        ],
      },
    );
  }

  if (stored.requester !== holder) {
    throw new YeaError(
      'forbidden',
      'only the agent that requested this proposal can commit it',
      { fix: [fix('send INTENT yourself, then commit your own proposal')] },
    );
  }
}

export async function verifyUndo(state: Verifier, req: Parsed<'UNDO'>) {
  const stored: StoredReceipt | undefined =
    req.receipt === null ? undefined : state.receipts.get(req.receipt);

  if (!stored || stored.receipt.undoes || req.receipt === null) {
    throw new YeaError(
      'not_found',
      `no undoable receipt ${JSON.stringify(req.receipt)}`,
    );
  }

  const { holder, principal } = await identifyRequired(state, req, {
    verb: 'UNDO',
    capability: stored.receipt.capability,
    target: req.receipt,
  });

  // SPEC §4.5: only a grant rooted in the principal of the original commit may undo it.
  if (principal !== stored.principal) {
    throw new YeaError(
      'forbidden',
      'only the principal who committed this can undo it',
    );
  }

  return { stored, holder, principal };
}

/** Handles from authenticated replies expand only for the same holder key (SPEC §4.6). */
export async function verifyExpand(state: Verifier, req: Parsed<'EXPAND'>) {
  const parked: Parked | undefined =
    req.handle === null ? undefined : state.handles.get(req.handle);

  if (!parked || req.handle === null) {
    throw new YeaError(
      'expired',
      `handle ${JSON.stringify(req.handle)} is unknown or expired`,
      { fix: [fix('repeat the original request')] },
    );
  }

  const owner = parked.owner ?? null;

  if (owner) {
    const err = await checkProof(
      req.proof ?? undefined,
      { aud: state.id, verb: 'EXPAND', target: req.handle },
      state.now(),
    );

    if (err || req.proof?.key !== owner) {
      throw new YeaError(
        'unauthorized',
        'this handle belongs to another agent',
        {
          fix: [
            fix('expand it with the same key that made the original request'),
          ],
        },
      );
    }
  } else if (state.opts.requireGrants) {
    throw new YeaError(
      'unauthorized',
      'EXPAND needs a grant from your principal',
    );
  }

  return { parked, owner };
}
