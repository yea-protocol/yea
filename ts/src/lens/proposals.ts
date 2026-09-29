/**
 * The Lens lines of a PROPOSALS reply (SPEC §9.2): each proposal with its
 * effects and attributes, the attributes they all share stated once.
 */
import type { Proposal } from '../types.js';
import { fmtUses } from '../uses.js';
import { isObject } from '../util.js';
import { effectLine, fmtDuration, fmtTime } from './format.js';
import { entry, scalar } from './notation.js';

/** An undo object with a `window` renders it as a duration; anything else is `never`. */
function undoWindow(undo: unknown): string {
  return isObject(undo) && 'window' in undo
    ? fmtDuration(undo.window)
    : 'never';
}

const ATTRS: [string, (p: Proposal) => string][] = [
  // Absent means nothing to show; anything else present renders, and a malformed one as `?`.
  ['uses', (p) => (p.uses === undefined ? '' : fmtUses(p.uses))],
  ['risk', (p) => scalar(p.risk)],
  ['undo', (p) => undoWindow(p.undo)],
  ['expires', (p) => fmtTime(p.expires)],
];

/** `k: v` for each attribute, joined with ` · `; an attribute that renders empty (no `uses`) is left out. */
function attrLine(attrs: typeof ATTRS, p: Proposal): string {
  return attrs
    .map(([k, f]) => [k, f(p)])
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
}

export function proposalsLines(ps: Proposal[]): string[] {
  // Attributes identical across all (N ≥ 2) proposals are stated once, in the header.
  const shared =
    ps.length >= 2
      ? ATTRS.filter(([, f]) => ps.every((p) => f(p) === f(ps[0])))
      : [];
  const own = ATTRS.filter((a) => !shared.includes(a));
  const header = attrLine(shared, ps[0]);
  const out = [
    `${ps.length} proposal${ps.length === 1 ? '' : 's'}${header ? ` — ${header}` : ''}:`,
  ];

  for (const p of ps) {
    out.push(
      `[${p.id}] ${p.summary}`,
      ...p.effects.map((e) => `  ${effectLine(e)}`),
    );

    const line = attrLine(own, p);

    if (line) {
      out.push(`  ${line}`);
    }

    if (p.data !== undefined) {
      out.push(...entry('data', p.data, 1));
    }
  }

  return out;
}
