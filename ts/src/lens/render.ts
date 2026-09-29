/**
 * Rendering a reply frame as Lens (SPEC §9.2): its kind's lines, then any
 * `more` lines.
 */
import type { More, Reply } from '../types.js';
import { lean } from './notation.js';
import { proposalsLines } from './proposals.js';
import {
  briefLines,
  clarifyLines,
  errorLines,
  eventLine,
  receiptLines,
} from './replies.js';

function moreLines(more: More[] | undefined): string[] {
  return (more ?? []).map(
    (m) =>
      `… ${m.remaining} more at ${m.path} — EXPAND ${m.handle} (~${m.est} tokens)`,
  );
}

function bodyLines(r: Reply): string[] {
  switch (r.kind) {
    case 'BRIEF':
      return briefLines(r);
    case 'ANSWER':
      return [lean(r.data)];
    case 'PROPOSALS':
      return proposalsLines(r.proposals);
    case 'CLARIFY':
      return clarifyLines(r);
    case 'RECEIPT':
      return receiptLines(r);
    case 'ERROR':
      return errorLines(r);
    case 'EVENT':
      return [eventLine(r)];
    default:
      return unknownLines(r);
  }
}

/**
 * Members a frame of unknown kind doesn't show: the envelope, `more` (it has its own lines) and
 * a service-supplied `lens`, which Lens never shows.
 */
const HIDDEN = new Set(['yea', 'id', 're', 'more', 'lens']);

/** A frame of a kind Lens doesn't know (SPEC §9.2): its other members in lean notation. */
function unknownLines(frame: object): string[] {
  const shown = Object.entries(frame).filter(([k]) => !HIDDEN.has(k));

  return [lean(Object.fromEntries(shown))];
}

/** Render a reply frame as Lens (SPEC §9.2). */
export function lens(r: Reply): string {
  const out = bodyLines(r);

  if ('more' in r) {
    out.push(...moreLines(r.more));
  }

  return out.join('\n');
}
