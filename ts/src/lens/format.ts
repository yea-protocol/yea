/**
 * Lens formatting helpers (SPEC §9.2): times, durations and effect lines.
 */
import type { Effect } from '../types.js';
import { scalar } from './notation.js';

const SYM: Record<string, string> = {
  create: '+',
  update: '~',
  delete: '-',
  send: '>',
  other: '*',
};

const isInteger = (v: unknown): v is number => Number.isSafeInteger(v);

/** 9999-12-31T23:59:59Z: past it the ISO form needs a six-digit year. */
const MAX_TIME = 253402300799;

/**
 * A Unix time as UTC `YYYY-MM-DDTHH:MM[:SS]Z` (SPEC §9.2). Anything but an integer in
 * [0, 9999-12-31T23:59:59Z] renders as its lean scalar instead, so a missing time is `-`.
 */
export function fmtTime(unix: unknown): string {
  if (!isInteger(unix) || unix < 0 || unix > MAX_TIME) {
    return scalar(unix);
  }

  const iso = new Date(unix * 1000).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const secs = iso.slice(17, 19);

  return `${iso.slice(0, 16) + (secs === '00' ? '' : `:${secs}`)}Z`;
}

/**
 * Seconds in the largest of `d`/`h`/`m`/`s` that divides them (SPEC §9.2). Anything but a
 * safe integer renders as its lean scalar instead.
 */
export function fmtDuration(s: unknown): string {
  if (!isInteger(s)) {
    return scalar(s);
  }

  if (s !== 0 && s % 86400 === 0) {
    return `${s / 86400}d`;
  }

  if (s !== 0 && s % 3600 === 0) {
    return `${s / 3600}h`;
  }

  if (s !== 0 && s % 60 === 0) {
    return `${s / 60}m`;
  }

  return `${s}s`;
}

export function effectLine(e: Effect): string {
  let s = `${Object.hasOwn(SYM, e.op) ? SYM[e.op] : '*'} ${e.op} ${e.target}${e.field ? `.${e.field}` : ''}`;

  if (e.from !== undefined || e.to !== undefined) {
    s += `: ${scalar(e.from ?? null)} → ${scalar(e.to ?? null)}`;
  }

  if (e.detail) {
    s += ` — ${e.detail}`;
  }

  return s;
}
