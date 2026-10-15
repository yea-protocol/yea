/**
 * The verified request (GLOSSARY.md): an untrusted frame, read for its verb, with what it names
 * looked up and its proof and grants checked. It says who is acting (the holder), for whom (the
 * principal) and, for a COMMIT, from which requester. Handlers get this, never the raw frame.
 *
 * It checks every caveat but `each`, `total` and `risk` (ADR-0002). Until #279 moves them to the
 * commit ledger, a COMMIT's `limits()` and an auto INTENT's `auto.grant()` check those here.
 */
import type { Parked } from '../budget.js';
import type { AskDef, IntentDef } from '../plan.js';
import type { StoredProposal, StoredReceipt } from './state.js';
import type { Authorized } from './verified-request/grants.js';
import { type ParsedRequest, parseRequest } from './verified-request/parse.js';
import {
  type AutoCommit,
  type Verifier,
  verifyAsk,
  verifyCommit,
  verifyExpand,
  verifyIntent,
  verifyUndo,
} from './verified-request/verbs.js';

export type { Authorized } from './verified-request/grants.js';
export type { ParsedRequest } from './verified-request/parse.js';
export type { AutoCommit, Verifier } from './verified-request/verbs.js';
export { parseRequest };

interface Base {
  id: string;
  /** The reply's budget: the frame's, or the service's default. */
  budget: number;
}

/** Who may be acting: both null for an anonymous request. */
interface Sender {
  holder: string | null;
  principal: string | null;
}

export type VerifiedAsk = Base &
  Sender & {
    verb: 'ASK';
    capability: string;
    def: AskDef;
    params: Record<string, unknown>;
  };

export type VerifiedIntent = Base &
  Sender & {
    verb: 'INTENT';
    capability: string;
    def: IntentDef;
    params: Record<string, unknown>;
    goal: string | null;
    /** Null unless the INTENT asked for auto-commit (`"auto": true`). */
    auto: AutoCommit | null;
  };

/** A COMMIT from the proposal's requester, under a grant from its principal. */
export type VerifiedCommit = Base & {
  verb: 'COMMIT';
  stored: StoredProposal;
  holder: string;
  principal: string;
  /** The grant that also admits the proposal's `each`, `total` and `risk`, or the error why none does. */
  limits(): Promise<Authorized>;
};

/** An UNDO under a grant from the principal who committed the receipt. */
export type VerifiedUndo = Base & {
  verb: 'UNDO';
  stored: StoredReceipt;
  holder: string;
  principal: string;
};

/** An EXPAND by the key the handle was made for (`owner`), or of an anonymous reply's handle. */
export type VerifiedExpand = Base & {
  verb: 'EXPAND';
  parked: Parked;
  owner: string | null;
};

export type VerifiedRequest =
  | (Base & { verb: 'HELLO' })
  | VerifiedAsk
  | VerifiedIntent
  | VerifiedCommit
  | VerifiedUndo
  | VerifiedExpand;

/**
 * Read a request frame and verify it for its verb. Throws the error to reply with: `bad_frame`
 * or `invalid_params` from the frame alone, then what a lookup or the grant check finds.
 */
export async function verifyRequest(
  state: Verifier,
  frame: unknown,
): Promise<VerifiedRequest> {
  const req = parseRequest(frame);
  const base: Base = {
    id: req.id,
    budget: req.budget ?? state.opts.defaultBudget ?? 2000,
  };

  return { ...base, ...(await verifyFor(state, req)) };
}

async function verifyFor(state: Verifier, req: ParsedRequest) {
  switch (req.verb) {
    case 'HELLO':
      return { verb: req.verb };
    case 'ASK':
      return { verb: req.verb, ...(await verifyAsk(state, req)) };
    case 'INTENT':
      return { verb: req.verb, ...(await verifyIntent(state, req)) };
    case 'COMMIT':
      return { verb: req.verb, ...(await verifyCommit(state, req)) };
    case 'UNDO':
      return { verb: req.verb, ...(await verifyUndo(state, req)) };
    case 'EXPAND':
      return { verb: req.verb, ...(await verifyExpand(state, req)) };
  }
}
