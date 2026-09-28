/**
 * What every bridge call shares: the pending proposals, the consent store, the read budget, the
 * person's unsigned tightening and the clock. It lives apart from types.ts because it names
 * `ConsentStore`: there it would make a type-only cycle with consent.ts.
 */
import type { ConsentStore } from './consent.js';
import type { PendingProposals } from './pending.js';

/** What every call shares: the pending proposals, the consent store and the clock. */
export interface Bridge {
  pending: PendingProposals;
  consents: ConsentStore;
  budget: number;
  /** Unsigned tightening merged with `~/.yea/policy.json`; only `deny` applies here. */
  tighten: unknown;
  now(): number;
}
