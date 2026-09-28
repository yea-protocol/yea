/** What a grant check (SPEC §6.4) is given, the request and its proposal, and what it returns. */
import type { Risk, Verb } from '../types.js';
import type { Uses } from '../uses.js';
import type { Caveat } from './token.js';

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
  /** The exact amount of measure `of` already committed or reserved under a block id (for `total`). */
  used?: (blockId: string, of: string) => bigint;
}

export type GrantCheck =
  | {
      ok: true;
      id: string;
      iss: string;
      holder: string;
      totals: TotalLimit[];
    }
  | {
      ok: false;
      code: 'unauthorized' | 'forbidden' | 'consent_required';
      reason: string;
      iss?: string;
      need?: Caveat[];
    };

/** A `total` caveat a COMMIT counts against: its block, measure and exact ceiling. */
export interface TotalLimit {
  id: string;
  of: string;
  max: bigint;
}
