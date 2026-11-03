/** The caveat flags of `yea grant` and `yea delegate`, and the caveats they ask for (SPEC §6.3). */
import type { Caveat } from '../grants.js';
import { isRisk } from '../risk.js';
import type { Verb } from '../types.js';
import { isLimit, type Limit } from '../uses.js';
import { unixNow } from '../util.js';
import type { Flags, Values } from './command.js';
import { die } from './shared.js';

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
    help: 'the highest risk allowed without asking',
  },
} as const satisfies Flags;

/** `30m`, `24h`, `7d` … → seconds. */
function duration(s: string): number {
  const m =
    /^(\d+)([smhd])$/.exec(s) ??
    die(`bad duration ${s} (use e.g. 30m, 24h, 7d)`);

  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's'];
}

/** `spend=25.00USD` or `emails=20` → a limit on that measure (SPEC §6.3). */
function limit(s: string): Limit {
  const m =
    /^([a-z][a-z0-9_.-]*)=(\d+)(?:\.(\d+))?\s*([A-Za-z%][A-Za-z0-9_./%-]*)?$/.exec(
      s,
    ) ?? die(`bad limit ${s} (use e.g. spend=25.00USD or emails=20)`);
  const decimals = m[3] ?? '';
  const l = {
    of: m[1],
    max: Number(m[2] + decimals),
    ...(decimals ? { scale: decimals.length } : {}),
    ...(m[4] ? { unit: m[4] } : {}),
  };

  return isLimit(l) ? l : die(`bad limit ${s} (amount or unit out of range)`);
}

/** The caveats the flags in `o` ask for; exits on a bad one. */
export function caveats(o: Values<typeof CAVEAT_FLAGS>): Caveat[] {
  const c: Caveat[] = [];

  if (o.svc) {
    c.push({ svc: o.svc });
  }

  if (o.can) {
    c.push({ can: o.can });
  }

  if (o.verbs) {
    c.push({
      verbs: o.verbs.split(',').map((v) => v.trim().toUpperCase()) as Verb[],
    });
  }

  if (o.exp) {
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
        : die(`bad risk ${o.risk} (low|medium|high)`),
    });
  }

  return c;
}
