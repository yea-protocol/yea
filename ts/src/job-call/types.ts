/** What a job call session works with and what each of its steps returns. */
import type { HashedPlan, Policy } from '../approval.js';
import type { ApprovalAnswer, ApprovalForm, ApprovalState } from '../ask.js';
import type { Clarification } from '../plan.js';
import type { ApprovalStore, Reservation } from '../store.js';
import type { Risk } from '../types.js';

/** The job tool being called, as the session needs it. */
export interface JobTool {
  name: string;
  risk?: Risk;
  /** The tool's `revert`: with it, a plan with an `undoWindow` can be undone. */
  revert?: unknown;
  /** The phrase the person types for a plan; `approve` when absent or empty. */
  confirmWith?(hp: HashedPlan, input: Record<string, unknown>): unknown;
}

/** One round of a job call: its facts, read afresh on every round. */
export interface JobCall {
  tool: JobTool;
  input: Record<string, unknown>;
  /**
   * The tool's handler: its plans, or a clarification. It runs on every round, and on preview,
   * so it must change nothing.
   */
  plan(): unknown;
  /** Show the plans; run and store nothing. */
  preview?: boolean;
  /** Who is calling. */
  sub: string;
  /** The call's time, in seconds. */
  now: number;
  policy: Policy;
  /** Whether the client can take an approval form this round. */
  canAsk: boolean;
  /** Why no principal key is pinned, when `policy.principal` is empty: no consent counts then. */
  unpinned?: string;
}

/** A retry: the state the last round handed out, as it came back, and the person's answer. */
export interface JobCallRetry {
  state: unknown;
  answer: ApprovalAnswer;
}

/** Plans to approve outside the chat, with a consent code for each one that may be approved. */
export interface ConsentCodes {
  why: string;
  plans: HashedPlan[];
  codes: { planHash: string; code: string }[];
  /** Why no consent can be accepted here, so there are no codes; null when there are. */
  unavailable: string | null;
}

/**
 * How a round ends:
 * - `clarify`: the handler's question, to return as it is;
 * - `preview`: the plans to show; nothing ran or was stored;
 * - `run`: apply this plan once, then settle `held` (or release it if `apply()` fails);
 * - `ask`: ask the person with this form, carrying `state` round the client, sealed. If the
 *   client turns out to be unreachable, `otherwise()` is what to return instead;
 * - `consent-codes`: nothing runs; the person approves outside the chat;
 * - `refuse`: nothing runs, and why. `again` means a new call asks afresh.
 */
export type JobCallOutcome =
  | { kind: 'clarify'; clarification: Clarification }
  | { kind: 'preview'; plans: HashedPlan[] }
  | {
      kind: 'run';
      plan: HashedPlan;
      held: Reservation[];
      how: 'auto' | 'approved';
    }
  | {
      kind: 'ask';
      form: ApprovalForm;
      state: ApprovalState;
      otherwise(): ConsentCodesOutcome;
    }
  | ConsentCodesOutcome
  | { kind: 'refuse'; why: string; again?: true };

export type ConsentCodesOutcome = { kind: 'consent-codes' } & ConsentCodes;

/** A round in progress: the call, its hashed plans, its store, and the phrase for each plan. */
export interface Round {
  call: JobCall;
  plans: HashedPlan[];
  store: ApprovalStore;
  phraseFor(hp: HashedPlan): string;
}
