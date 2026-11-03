/**
 * Where `yea approve` finds pending codes (docs/framework/SPEC-approval.md §6, Short ids): the
 * home's `pending/`, which the bridge writes, then the store's, which a framework server writes.
 * It lists them, and reads one by its id; what it reads is checked as any pasted code is, and
 * a file's text is never echoed back.
 */
import { join } from 'node:path';
import { decodeConsentCode } from '../consent.js';
import {
  defaultFileStore,
  homePending,
  issuerEnded,
  PENDING_ID,
  type PendingCode,
  type PendingCodes,
  type PendingConsent,
  pendingCodesOf,
} from '../file-store.js';
import { loadConsent } from '../home.js';
import { fmtTime } from '../lens.js';
import { clip, printable } from '../text.js';

/** A listed summary is cut to this many code points, once its whitespace is collapsed. */
const SUMMARY_MAX = 80;

/** Why a pending id can't be used, and what to do instead. */
const AGAIN =
  'call the tool again for a fresh one, or, if the agent runs as another OS user or on another machine, pass the whole code instead';

/** What one directory holds under an id: the code on its first line, or why it can't be read. */
type Found = { dir: string } & ({ code: string } | { why: string });

/** The home's pending codes, then the store's; one directory once, if both are the same. */
function places(): PendingCodes[] {
  const all = [homePending(), pendingCodesOf(defaultFileStore())].filter(
    (p): p is PendingCodes => p !== null,
  );

  return all.filter((p, i) => all.findIndex((q) => q.dir === p.dir) === i);
}

const lookedIn = (ps: PendingCodes[]) =>
  `looked in ${ps.map((p) => p.dir).join(' and ')}`;

/** Every directory with a file named exactly `id`. */
const findAll = (ps: PendingCodes[], id: string): Found[] =>
  ps.flatMap((p): Found[] => {
    try {
      const code = p.read(id);

      return code === null ? [] : [{ dir: p.dir, code }];
    } catch (e) {
      return [{ dir: p.dir, why: (e as Error).message }];
    }
  });

/** When a consent code expires, or null if the text isn't one. */
function expiryOf(code: string): number | null {
  if (!code.startsWith('pc1.')) {
    return null;
  }

  try {
    return decodeConsentCode(code).expires;
  } catch {
    return null;
  }
}

/** A pending file's code as `yea approve` may take it, or why not, never quoting the file. */
function usable(
  id: string,
  f: { dir: string; code: string },
  now: number,
): { code: string } | { why: string } {
  const expires = expiryOf(f.code);

  if (expires === null) {
    return {
      why: `pending file ${join(f.dir, id)} doesn't hold a consent code: call the tool again for a fresh one`,
    };
  }

  return expires <= now
    ? { why: `pending approval ${id} (in ${f.dir}) has expired: ${AGAIN}` }
    : { code: f.code };
}

/**
 * The code stored under `id`, or why there is none to approve: not an id, no such file (and
 * where it looked), one in both directories (an id must name one approval), a file it won't
 * read or that holds no code, or a code that has expired (and where it is).
 */
export function pendingCode(
  id: string,
  now: number,
): { code: string } | { why: string } {
  if (!PENDING_ID.test(id)) {
    return { why: 'not a consent code (pc1.…) or a pending id' };
  }

  const ps = places();
  const found = findAll(ps, id);

  if (!found.length) {
    return { why: `no pending approval ${id} (${lookedIn(ps)}): ${AGAIN}` };
  }

  if (found.length > 1) {
    return {
      why: `pending id ${id} is in both ${found.map((f) => f.dir).join(' and ')}, so it doesn't name one approval: ${AGAIN}`,
    };
  }

  const [f] = found;

  return 'why' in f ? { why: f.why } : usable(id, f, now);
}

/** Service text as one listing field: whitespace runs collapsed, cut to `max`, then escaped. */
function field(s: string, max = Infinity): string {
  return printable(clip(s.replace(/\s+/g, ' ').trim(), max));
}

/**
 * Whether a consent for this code is saved already, so it's waiting for the agent's next call:
 * in the home under the proposal's hash (the bridge's), or in the store under the plan hash.
 */
async function approved(c: PendingConsent): Promise<boolean> {
  try {
    return (
      loadConsent(c.hash) !== null ||
      (await defaultFileStore().getConsent(c.proposal)) !== null
    );
  } catch {
    return false;
  }
}

/** What's next for an entry: nothing yet, its bridge has stopped, or it's approved. */
async function status(e: PendingCode): Promise<string[]> {
  if (issuerEnded(e)) {
    return ['its bridge has stopped: call the tool again'];
  }

  return (await approved(e.consent)) ? ['approved, waiting for the agent'] : [];
}

/** One listed code: its id, then every service-written field on the same line. */
async function entryLine(e: PendingCode): Promise<string> {
  const c = e.consent;

  return [
    `  ${e.id}`,
    field(c.capability),
    field(c.summary, SUMMARY_MAX),
    `at ${field(c.service)}`,
    `expires ${fmtTime(c.expires)}`,
    ...(await status(e)),
  ].join(' · ');
}

/** The pending codes that haven't expired, by directory, one line each. */
export async function pendingLines(now: number): Promise<string[]> {
  const ps = places();
  const groups = await Promise.all(
    ps.map(async (p) => {
      const entries = p.list(now);

      return entries.length
        ? [`in ${p.dir}:`, ...(await Promise.all(entries.map(entryLine)))]
        : [];
    }),
  );
  const lines = groups.flat();

  return lines.length
    ? ['pending approvals (yea approve <id> to review one):', ...lines]
    : [`no pending approvals (${lookedIn(ps)})`];
}
