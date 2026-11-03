/** The caveat flags of `yea grant` and `yea delegate`, and the caveats they ask for (SPEC §6.3). */
import type { Caveat } from '../grants.js';
import { isRisk, RISKS } from '../risk.js';
import { isVerb, VERBS, type Verb } from '../types.js';
import { isLimit, type Limit } from '../uses.js';
import { unixNow } from '../util.js';
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
    value: 'measure=max',
    help: 'a limit over all commits, such as emails=20',
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

  for (const l of o.each ?? []) {
    c.push({ each: limit(l) });
  }

  for (const l of o.total ?? []) {
    c.push({ total: limit(l) });
  }

  if (o.risk !== undefined) {
    c.push({
      risk: isRisk(o.risk)
        ? o.risk
        : bad(`bad risk ${o.risk} (low|medium|high)`),
    });
  }

  return c;
}
