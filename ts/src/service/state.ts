/** The state one Service shares with its verb handlers: registered capabilities, proposals, receipts and the `total` ledger. */
import type { Authorizer } from '../authorize.js';
import type { HandleStore } from '../budget.js';
import type { AskDef, IntentDef, Plan, ServiceOptions } from '../plan.js';
import type {
  ErrorReply,
  FinalReply,
  Proposal,
  Receipt,
  ReceiptReply,
} from '../types.js';

/** `requester`: the holder key whose verified proof asked for this proposal; only it may commit it. */
export interface StoredProposal {
  proposal: Proposal;
  plan: Plan;
  principal: string | null;
  requester: string | null;
  created: number;
}

export interface StoredReceipt {
  receipt: Receipt;
  plan: Plan;
  result: unknown;
  principal: string;
  undone?: Promise<ReceiptReply | ErrorReply>;
}

export const DAY = 86400;

/** One instance per Service: every handler holds these same references. */
export interface ServiceState {
  readonly id: string;
  readonly opts: ServiceOptions;
  readonly asks: Map<string, AskDef>;
  readonly intents: Map<string, IntentDef>;
  readonly proposals: Map<string, StoredProposal>;
  readonly commits: Map<string, Promise<ReceiptReply | ErrorReply>>;
  readonly receipts: Map<string, StoredReceipt>;
  /** Exact amounts committed or reserved per `total` (block id and measure). */
  readonly used: Map<string, bigint>;
  readonly autoSeen: Map<string, { reply: Promise<FinalReply>; exp: number }>;
  readonly handles: HandleStore;
  readonly now: () => number;
  readonly authorizer: Authorizer;
}
