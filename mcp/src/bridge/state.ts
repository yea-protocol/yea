/**
 * What every bridge call shares: the pending proposals, the consent store (the consent round's
 * seam), the read budget, the person's unsigned tightening and the clock.
 */
import type { ConsentStore } from '@yea-protocol/sdk';
import type { PendingProposals } from './pending.js';

/** What every call shares: the pending proposals, the consent store and the clock. */
export interface Bridge {
  pending: PendingProposals;
  consents: ConsentStore;
  budget: number;
  /** Unsigned tightening merged with the home's `policy.json`; only `deny` applies here. */
  tighten: unknown;
  /** The agent's home directory, where `policy.json` is read on every call; resolved once. */
  home: string;
  now(): number;
}
