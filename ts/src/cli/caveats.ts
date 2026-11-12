/** The caveat flags of `yea grant` and `yea delegate`, and the caveats they ask for (SPEC §6.3). */
import type { Caveat } from '../grants.js';
import { PROOF_SKEW } from '../proof.js';
import { isRisk, RISKS } from '../risk.js';
import { isVerb, VERBS, type Verb } from '../types.js';
import { isLimit, type Limit } from '../uses.js';
import { DAY, unixNow } from '../util.js';
import { type Flags, UsageError, type Values } from './command.js';

/** The caveat flags of `grant` and `delegate`, each a caveat (SPEC §6.3). */
export const CAVEAT_FLAGS = {
  svc: {
    type: 'string',
    multiple: true,
    value: 'id',
    help: 'only this service',
  },
  can: {
    type: 'string',
    multiple: true,
    value: 'pattern',
    help: 'only capabilities matching this, such as "calendar.*"',
  },
  verbs: {
    type: 'string',
    value: 'A,B',
    help: 'only these verbs, such as ASK,INTENT',
  },
  exp: {
    type: 'string',
    value: 'duration',
    help: 'expires after 30m, 24h, 7d …',
  },
  each: {
    type: 'string',
    multiple: true,
    value: 'measure=max',
    help: 'a limit per commit, such as spend=25.00USD',
  },
  total: {
    type: 'string',
    multiple: true,
    value: 'measure=max[/period]',
    help: 'a limit over all commits, such as emails=20, or per period from today, such as spend=500USD/7d (needs --exp)',
  },
  risk: {
    type: 'string',
    value: 'low|medium|high',
    choices: RISKS,
    help: 'the highest risk allowed without asking',
  },
} as const satisfies Flags;

/** Refuse a caveat flag's value: a usage error, before any key is read. */
function bad(message: string): never {
  throw new UsageError(message);
}

/** `30m`, `24h`, `7d` … → seconds. */
function duration(s: string): number {
  const m =
    /^(\d+)([smhd])$/.exec(s) ??
    bad(`bad duration ${s} (use e.g. 30m, 24h, 7d)`);

  const seconds =
    Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's'];

  // A grant's exp is canonical JSON, which holds only safe integers.
  return Number.isSafeInteger(unixNow() + seconds)
    ? seconds
    : bad(`bad duration ${s} (too long)`);
}

/** `ASK,INTENT` → those verbs; an unknown or empty one is refused. */
function verbs(s: string): Verb[] {
  return s.split(',').map((v) => {
    const verb = v.trim().toUpperCase();

    return isVerb(verb)
      ? verb
      : bad(`bad verb ${JSON.stringify(v.trim())} (one of ${VERBS.join(',')})`);
  });
}

/** A repeatable flag's values, such as --svc's; an empty one is refused. */
function nonEmpty(flag: string, values: string[]): string[] {
  return values.every((v) => v.trim() !== '')
    ? values
    : bad(`--${flag} needs a non-empty value`);
}

/** `spend=25.00USD` or `emails=20` → a limit on that measure (SPEC §6.3). */
function limit(s: string): Limit {
  const m =
    /^([a-z][a-z0-9_.-]*)=(\d+)(?:\.(\d+))?\s*([A-Za-z%][A-Za-z0-9_./%-]*)?$/.exec(
      s,
    ) ?? bad(`bad limit ${s} (use e.g. spend=25.00USD or emails=20)`);
  const decimals = m[3] ?? '';
  const l = {
    of: m[1],
    max: Number(m[2] + decimals),
    ...(decimals ? { scale: decimals.length } : {}),
    ...(m[4] ? { unit: m[4] } : {}),
  };

  return isLimit(l) ? l : bad(`bad limit ${s} (amount or unit out of range)`);
}

/** A period: `<n>` seconds, minutes, hours or days, n ≥ 1. */
const PERIOD = /^[1-9]\d*[smhd]$/;

/** `--each`'s limit. A period after a `/` is refused: only a total counts per period. */
function each(s: string): Limit {
  return /\/\d+[smhd]$/.test(s)
    ? bad(
        `--each ${s}: each takes no period (use --total for a limit per period)`,
      )
    : limit(s);
}

/**
 * `--total`'s limit: `spend=500USD` for the grant's lifetime, or `spend=500USD/7d` per period
 * (SPEC §6.3). Whatever follows the `/` is the period, so a unit with a `/` can't be set here.
 */
function total(s: string): Limit {
  const slash = s.indexOf('/');

  if (slash < 0) {
    return limit(s);
  }

  const period = s.slice(slash + 1);

  if (!PERIOD.test(period)) {
    bad(
      `bad period ${JSON.stringify(period)} in --total ${s} (use e.g. 24h, 7d)`,
    );
  }

  return { ...limit(s.slice(0, slash)), every: duration(period) };
}

/**
 * The `nbf` a total with a period counts from: 00:00 UTC on the day of `now` minus the proof
 * skew, so a service whose clock is behind ours by as much as a proof allows already accepts it.
 */
const periodAnchor = (now: number) =>
  Math.floor((now - PROOF_SKEW) / DAY) * DAY;

/**
 * The `each` and `total` caveats the flags ask for. A total with a period counts from one `nbf`
 * in its block, 00:00 UTC today (or yesterday, in the first minutes of the day), so it needs
 * `--exp` to end: its max comes back every period.
 */
function limitCaveats(o: Values<typeof CAVEAT_FLAGS>): Caveat[] {
  const eaches = (o.each ?? []).map((s) => ({ each: each(s) }));
  const totals = (o.total ?? []).map((s) => ({ s, limit: total(s) }));
  const periodic = totals.find((t) => t.limit.every !== undefined);

  if (periodic && o.exp === undefined) {
    bad(
      `--total ${periodic.s} needs --exp: its max comes back every period until the grant ends`,
    );
  }

  return [
    ...eaches,
    ...totals.map((t) => ({ total: t.limit })),
    ...(periodic ? [{ nbf: periodAnchor(unixNow()) }] : []),
  ];
}

/** The caveats the flags in `o` ask for; exits on a bad one. */
export function caveats(o: Values<typeof CAVEAT_FLAGS>): Caveat[] {
  const c: Caveat[] = [];

  if (o.svc) {
    c.push({ svc: nonEmpty('svc', o.svc) });
  }

  if (o.can) {
    c.push({ can: nonEmpty('can', o.can) });
  }

  if (o.verbs !== undefined) {
    c.push({ verbs: verbs(o.verbs) });
  }

  if (o.exp !== undefined) {
    c.push({ exp: unixNow() + duration(o.exp) });
  }

  c.push(...limitCaveats(o));

  if (o.risk !== undefined) {
    c.push({
      risk: isRisk(o.risk)
        ? o.risk
        : bad(`bad risk ${o.risk} (low|medium|high)`),
    });
  }

  return c;
}
