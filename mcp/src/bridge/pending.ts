/**
 * Pending proposals (SPEC-bridge, "How a job tool call runs"): the proposals a call got, kept in
 * memory so the next identical call commits exactly the one the person approved. They live in
 * the `bridge()` closure for the life of the process, not in a server instance.
 */
import { type Proposal, sha256 } from '@yea-protocol/sdk';

/** At most this many entries; the oldest is dropped first. */
export const MAX_PENDING = 256;

/** A proposal gets no new code once it has less than this many seconds left. */
const MIN_LEFT = 120;

/** One call's proposals, the principal they need consent from, and their consent codes. */
export interface Pending {
  key: string;
  tool: string;
  service: string;
  capability: string;
  /** The root `iss` of the grants sent on the INTENT; null when there isn't exactly one. */
  principal: string | null;
  proposals: Proposal[];
  /** A code per proposal that can be approved (`yea approve`). */
  codes: { proposal: string; code: string }[];
  /** Consents a COMMIT failed with: never tried again for this entry. */
  refused: Set<string>;
}

/** JSON with every object's keys sorted. Unlike `canonical`, it takes floats: `number` params. */
export function sortedJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );
}

/** The cache key: the tool, the capability, and a hash of the params (never sent anywhere). */
export async function pendingKey(
  tool: string,
  capability: string,
  params: Record<string, unknown>,
): Promise<string> {
  return `${tool}\0${capability}\0${await sha256(sortedJson(params))}`;
}

/** Whether a proposal has enough time left to hand out a code for it: approved, then committed. */
export const approvable = (p: Proposal, now: number) =>
  p.expires - now >= MIN_LEFT;

/** Whether a proposal hasn't expired: an approval already saved can still commit it. */
const alive = (p: Proposal, now: number) => p.expires > now;

/**
 * `e` with its expired proposals dropped, and codes only for the approvable ones: a proposal with
 * under 2 minutes left stays, marked "no new codes", until it really expires.
 */
function prune(e: Pending, now: number): Pending {
  e.proposals = e.proposals.filter((p) => alive(p, now));

  const coded = new Set(
    e.proposals.filter((p) => approvable(p, now)).map((p) => p.id),
  );

  e.codes = e.codes.filter((c) => coded.has(c.proposal));

  return e;
}

/** The bounded, expiring map of pending entries. */
export class PendingProposals {
  private entries = new Map<string, Pending>();

  /**
   * The live entry for `key`. A proposal loses its code at 2 minutes left and is dropped when it
   * expires; the entry, once none are left.
   */
  get(key: string, now: number): Pending | undefined {
    const e = this.entries.get(key);

    if (e && !prune(e, now).proposals.length) {
      this.entries.delete(key);

      return undefined;
    }

    return e;
  }

  /** How many entries are kept. */
  get size() {
    return this.entries.size;
  }

  /** Keep `e` (replacing any entry for its key), dropping the oldest past the bound. */
  set(e: Pending) {
    this.entries.delete(e.key);
    this.entries.set(e.key, e);

    for (const k of this.entries.keys()) {
      if (this.entries.size <= MAX_PENDING) {
        break;
      }

      this.entries.delete(k);
    }
  }

  drop(key: string) {
    this.entries.delete(key);
  }

  /** Every live entry, oldest first. */
  live(now: number): Pending[] {
    return [...this.entries.keys()].flatMap((k) => this.get(k, now) ?? []);
  }
}
