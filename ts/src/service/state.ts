/** The state one Service shares with its verb handlers: registered capabilities, the commit ledger and parked handles. */
import type { HandleStore } from '../budget.js';
import type { AskDef, IntentDef, ServiceOptions } from '../plan.js';
import type { CommitLedger } from './commit-ledger.js';

/** One instance per Service: every handler holds these same references. */
export interface ServiceState {
  readonly id: string;
  readonly opts: ServiceOptions;
  readonly asks: Map<string, AskDef>;
  readonly intents: Map<string, IntentDef>;
  /** Every proposal's life, and the usage ledger its `total` limits count against. */
  readonly ledger: CommitLedger;
  readonly handles: HandleStore;
  readonly now: () => number;
}
