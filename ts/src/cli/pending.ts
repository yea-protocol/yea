/**
 * Where `yea approve` finds pending codes (docs/framework/SPEC-approval.md §6, Short ids): the
 * home's `pending/`, which the bridge writes, then the store's, which a framework server writes.
 * It lists them, and reads one by its id; what it reads is checked as any pasted code is.
 */
import { decodeConsentCode } from '../consent.js';
import {
  defaultFileStore,
  homePending,
  PENDING_ID,
  type PendingCodes,
  pendingCodesOf,
} from '../file-store.js';
import { fmtTime } from '../lens.js';
import { printable } from '../text.js';

/** The home's pending codes, then the store's; one directory once, if both are the same. */
function places(): PendingCodes[] {
  const all = [homePending(), pendingCodesOf(defaultFileStore())].filter(
    (p): p is PendingCodes => p !== null,
  );

  return all.filter((p, i) => all.findIndex((q) => q.dir === p.dir) === i);
}

const lookedIn = (ps: PendingCodes[]) =>
  `looked in ${ps.map((p) => p.dir).join(' and ')}`;

/** Why a pending id can't be used, and what to do instead. */
const AGAIN =
  'call the tool again for a fresh one, or, if the agent runs as another OS user or on another machine, pass the whole code instead';

/**
 * The code stored under `id`, or why there is none to approve: not an id, no such file (and
 * where it looked), a file it won't read, or a code that has expired (and where it is).
 */
export function pendingCode(
  id: string,
  now: number,
): { code: string } | { why: string } {
  if (!PENDING_ID.test(id)) {
    return { why: 'not a consent code (pc1.…) or a pending id' };
  }

  const ps = places();

  for (const p of ps) {
    let code: string | null;

    try {
      code = p.read(id);
    } catch (e) {
      return { why: (e as Error).message };
    }

    if (code !== null) {
      return expired(code, now)
        ? { why: `pending approval ${id} (in ${p.dir}) has expired: ${AGAIN}` }
        : { code };
    }
  }

  return { why: `no pending approval ${id} (${lookedIn(ps)}): ${AGAIN}` };
}

/** Whether a code says it has expired; one that doesn't decode is left to the code's own checks. */
function expired(code: string, now: number): boolean {
  try {
    return decodeConsentCode(code).expires <= now;
  } catch {
    return false;
  }
}

/** The pending codes that haven't expired, one line each, every service-written field escaped. */
export function pendingLines(now: number): string[] {
  const ps = places();
  const lines = ps.flatMap((p) =>
    p
      .list(now)
      .map(({ id, consent: c }) =>
        [
          `  ${id}`,
          printable(c.capability),
          printable(c.summary),
          `at ${printable(c.service)}`,
          `expires ${fmtTime(c.expires)}`,
        ].join(' · '),
      ),
  );

  return lines.length
    ? ['pending approvals (yea approve <id> to review one):', ...lines]
    : [`no pending approvals (${lookedIn(ps)})`];
}
