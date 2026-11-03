/**
 * Pending proposals (SPEC-bridge, "How a job tool call runs"): the proposals a call got, kept in
 * memory so the next identical call commits exactly the one the person approved. They live in
 * the `bridge()` closure for the life of the process, not in a server instance. Each code shown
 * also has a pending file in the home (step 6), which goes when its code or entry does.
 */
import { type Proposal, sha256 } from '@yea-protocol/sdk';
import type { PendingCodes } from '@yea-protocol/sdk/node';
import { errorMessage, warnOnce } from '../util.js';

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
  codes: Code[];
  /** The ids (`consentId`) of consents a COMMIT failed with: never tried again for this entry. */
  refused: Set<string>;
}

/** A proposal's consent code, and its short id once its pending file is written. */
export interface Code {
  proposal: string;
  code: string;
  id?: string;
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
 * Drop `e`'s expired proposals, and its codes for all but the approvable ones: a proposal with
 * under 2 minutes left stays, marked "no new codes", until it really expires. Returns the codes
 * it dropped.
 */
function prune(e: Pending, now: number): Code[] {
  e.proposals = e.proposals.filter((p) => alive(p, now));

  const coded = new Set(
    e.proposals.filter((p) => approvable(p, now)).map((p) => p.id),
  );
  const gone = e.codes.filter((c) => !coded.has(c.proposal));

  e.codes = e.codes.filter((c) => coded.has(c.proposal));

  return gone;
}

/** The bounded, expiring map of pending entries, and their pending files. */
export class PendingProposals {
  private entries = new Map<string, Pending>();
  private readonly files: PendingCodes | null;

  /** `files`: where codes get short ids (`<home>/pending`); none, and codes have no ids. */
  constructor(files: PendingCodes | null = null) {
    this.files = files;
  }

  /**
   * The live entry for `key`. A proposal loses its code at 2 minutes left and is dropped when it
   * expires; the entry, once none are left.
   */
  get(key: string, now: number): Pending | undefined {
    const e = this.entries.get(key);

    if (!e) {
      return undefined;
    }

    this.unfile(e.service, prune(e, now));

    if (!e.proposals.length) {
      this.drop(key);

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
    this.drop(e.key);
    this.entries.set(e.key, e);

    for (const k of this.entries.keys()) {
      if (this.entries.size <= MAX_PENDING) {
        break;
      }

      this.drop(k);
    }
  }

  /** Forget the entry for `key`, and remove its pending files. */
  drop(key: string) {
    const e = this.entries.get(key);

    this.entries.delete(key);

    if (e) {
      this.unfile(e.service, e.codes);
    }
  }

  /**
   * `codes` with their short ids, each pending file written (again): a code shown before keeps
   * its id. If any write fails, the codes come back without ids, and say so on stderr.
   */
  filed(codes: Code[], now: number): Code[] {
    const files = this.files;

    if (!files) {
      return codes;
    }

    try {
      return codes.map((c) => ({ ...c, id: files.put(c.code, now) }));
    } catch (e) {
      warnOnce(
        `can't write a pending file, so no short ids: ${errorMessage(e)}`,
      );

      return codes;
    }
  }

  /**
   * At start-up: remove the files a bridge with this agent key wrote before for these services.
   * No proposal of theirs is held here, so their codes could never commit (decision 3).
   */
  clearOwn(services: { id: string; agent: string | null }[]) {
    const mine = new Set(
      services.flatMap((s) => (s.agent ? [`${s.id}\0${s.agent}`] : [])),
    );

    this.quietly(() =>
      this.files?.clear((c) => mine.has(`${c.service}\0${String(c.agent)}`)),
    );
  }

  /** Every live entry, oldest first. */
  live(now: number): Pending[] {
    return [...this.entries.keys()].flatMap((k) => this.get(k, now) ?? []);
  }

  /** Remove the pending files of `codes`, a service's codes that are gone. */
  private unfile(service: string, codes: Code[]) {
    for (const c of codes) {
      this.quietly(() => this.files?.drop(service, c.proposal));
    }
  }

  /** A file that can't be removed only lingers, hidden once it expires: never fail a call on it. */
  private quietly(f: () => void) {
    try {
      f();
    } catch (e) {
      warnOnce(`can't remove a pending file: ${errorMessage(e)}`);
    }
  }
}
