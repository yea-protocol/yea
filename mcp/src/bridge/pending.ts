/**
 * Pending proposals (SPEC-bridge, "How a job tool call runs"): the proposals a call got, kept in
 * memory so the next identical call commits exactly the one the person approved. They live in
 * the `bridge()` closure for the life of the process, not in a server instance.
 */
import { type Proposal, sha256 } from '@yea-protocol/sdk';

/** At most this many entries; the oldest is dropped first. */
export const MAX_PENDING = 256;

/** An entry is dropped once its proposals have less than this many seconds left. */
export const MIN_LEFT = 120;

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

/** Seconds until the first of `proposals` expires. */
const leftOf = (proposals: Proposal[], now: number) =>
  Math.min(...proposals.map((p) => p.expires)) - now;

/** Whether proposals still have enough time left to be approved and committed. */
export const fresh = (proposals: Proposal[], now: number) =>
  proposals.length > 0 && leftOf(proposals, now) >= MIN_LEFT;

/** The bounded, expiring map of pending entries. */
export class PendingProposals {
  private entries = new Map<string, Pending>();

  /** The live entry for `key`, dropping it if it's too close to expiry. */
  get(key: string, now: number): Pending | undefined {
    const e = this.entries.get(key);

    if (e && !fresh(e.proposals, now)) {
      this.entries.delete(key);

      return undefined;
    }

    return e;
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
