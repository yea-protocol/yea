/** What a grant check (SPEC §6.4) is given, the request and its proposal, and what it returns. */
import type { Risk, Verb } from '../types.js';
import type { Uses } from '../uses.js';
import type { Block, Caveat } from './token.js';

export interface CheckContext {
  service: string;
  verb: Verb;
  capability: string;
  now?: number;
  /** For COMMIT: the proposal being committed. */
  proposal?: { hash: string; uses?: Uses; risk: Risk };
  /** Principals the service trusts. */
  trusted: string[] | ((iss: string) => boolean);
  /** The key that signed the request proof; must equal the grant holder. */
  proofKey: string;
  /** The exact amount already committed or reserved against a `total`'s ledger entry. */
  used?: (key: LedgerKey) => bigint;
  /**
   * False checks who may act only (ADR-0002): `each`, `total` and `risk` are still checked for
   * shape, but never deny and count no `total`. Defaults to true.
   */
  limits?: boolean;
}

export type GrantCheck =
  | {
      ok: true;
      id: string;
      iss: string;
      holder: string;
      totals: TotalLimit[];
      /** The grant's blocks, as decoded and verified. */
      blocks: Block[];
    }
  | {
      ok: false;
      code: 'unauthorized' | 'forbidden' | 'consent_required';
      reason: string;
      iss?: string;
      need?: Caveat[];
    };

/** The period of a `total` with `every` that a COMMIT counts in: its length and its start. */
export interface Period {
  every: number;
  start: number;
}

/**
 * Where a `total` counts (SPEC §6.3): its block id and measure, and for one with `every`, the
 * period. A commit's period is worked out once, when its grant is checked, and carried here.
 */
export interface LedgerKey {
  block: string;
  of: string;
  period?: Period;
}

/** A `total` caveat a COMMIT counts against: where it counts, and its exact ceiling. */
export interface TotalLimit {
  key: LedgerKey;
  max: bigint;
}
