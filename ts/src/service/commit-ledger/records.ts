/**
 * What the commit ledger keeps and is given: a stored proposal and receipt, the grant evaluation a
 * commit brings with it (ADR-0002), and the receipt a commit issues.
 */
import { randomId } from '../../crypto.js';
import type { YeaError } from '../../errors.js';
import type { TotalLimit } from '../../grants.js';
import type { Plan, ServiceOptions } from '../../plan.js';
import type { LedgerKey } from '../../store.js';
import type {
  ErrorReply,
  Event,
  Proposal,
  Receipt,
  ReceiptReply,
} from '../../types.js';

/** `requester`: the holder key whose verified proof asked for this proposal; only it may commit it. */
export interface StoredProposal {
  proposal: Proposal;
  plan: Plan;
  principal: string | null;
  requester: string | null;
  created: number;
}

/** `principal`: the issuer of the grant the commit ran under; only it may undo or replay it. */
export interface StoredReceipt {
  receipt: Receipt;
  plan: Plan;
  result: unknown;
  principal: string;
}

/** The amount the usage ledger holds against a `total`, settled and reserved. */
export type Used = (key: LedgerKey) => bigint;

/** The grant that admits a proposal: its principal, and the `total` limits it counts against. */
export interface Admitted {
  iss: string;
  totals: TotalLimit[];
}

/**
 * Grant evaluation with the limits included (ADR-0002), over the request's own grants: the
 * grant that admits `proposal` given what `used` holds, or the error that says why none does.
 */
export type Admit = (
  proposal: Proposal,
  used: Used,
) => Promise<Admitted | YeaError>;

/** Everything the ledger keeps, by id. */
export interface Records {
  proposals: Map<string, StoredProposal>;
  /** A commit's run, by proposal id: in flight or done. A failed run is removed, to allow a retry. */
  runs: Map<string, Promise<ReceiptReply | ErrorReply>>;
  receipts: Map<string, StoredReceipt>;
  /** An undo's run, by receipt id, removed like a commit's when it fails. */
  undos: Map<string, Promise<ReceiptReply | ErrorReply>>;
}

/** What the ledger reads of its service: its id, its options (for `onError`) and its clock. */
export interface LedgerOptions {
  id: string;
  opts: ServiceOptions;
  now: () => number;
}

/** A COMMIT of a stored proposal: the frame it answers, its principal, and its grants' evaluation. */
export interface Commit {
  id: string;
  stored: StoredProposal;
  principal: string;
  admit: Admit;
}

/** An UNDO of a stored receipt by the principal who committed it. */
export interface Undo {
  id: string;
  stored: StoredReceipt;
  principal: string;
}

/** The frame a run answers, and where its EVENTs go. */
export interface Answer {
  re: string;
  emit: (e: Event) => void;
}

/** The receipt for a proposal applied at `at`, with the plan's result. */
export function receiptFor(
  proposal: Proposal,
  result: unknown,
  at: number,
): Receipt {
  return {
    id: randomId('r', 6),
    proposal: proposal.id,
    capability: proposal.capability,
    summary: proposal.summary,
    at,
    effects: proposal.effects,
    ...(proposal.uses ? { uses: proposal.uses } : {}),
    undo: proposal.undo ? { until: at + proposal.undo.window } : null,
    ...(result !== undefined && result !== null ? { result } : {}),
  };
}
