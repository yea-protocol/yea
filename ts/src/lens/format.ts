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

export function fmtTime(unix: number): string {
  const iso = new Date(unix * 1000).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const secs = iso.slice(17, 19);

  return `${iso.slice(0, 16) + (secs === '00' ? '' : `:${secs}`)}Z`;
}

export function fmtDuration(s: number): string {
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
  let s = `${SYM[e.op] ?? '*'} ${e.op} ${e.target}${e.field ? `.${e.field}` : ''}`;

  if (e.from !== undefined || e.to !== undefined) {
    s += `: ${scalar(e.from ?? null)} → ${scalar(e.to ?? null)}`;
  }

  if (e.detail) {
    s += ` — ${e.detail}`;
  }

  return s;
}
