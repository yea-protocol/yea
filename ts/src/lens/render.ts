/**
 * Rendering a reply frame as Lens (SPEC §9.2): its kind's lines, then any
 * `more` lines.
 */
import type { More, Reply } from '../types.js';
import { isObject } from '../util.js';
import { clipDepth } from './depth.js';
import { lean } from './notation.js';
import { proposalsLines } from './proposals.js';
import {
  briefLines,
  clarifyLines,
  errorLines,
  eventLine,
  receiptLines,
} from './replies.js';
import { kindFits, moreOf } from './shape.js';

function moreLines(more: More[]): string[] {
  return more.map(
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
      return unknownLines(r, true);
  }
}

/**
 * Members a frame of unknown kind doesn't show: the envelope, `more` (it has its own lines, when
 * well-formed) and a service-supplied `lens`, which Lens never shows.
 */
const HIDDEN = new Set(['yea', 'id', 're', 'lens']);

/**
 * A frame of a kind Lens doesn't know, or not well-formed (SPEC §9.2): its other members in lean
 * notation. A malformed `more` is one of them.
 */
function unknownLines(frame: object, moreOk: boolean): string[] {
  const shown = Object.entries(frame).filter(
    ([k]) => !HIDDEN.has(k) && (k !== 'more' || !moreOk),
  );

  return [lean(Object.fromEntries(shown))];
}

/**
 * Render a reply frame as Lens (SPEC §9.2), clipped to MAX_DEPTH. A missing, wrong-typed or
 * deeply nested member can't make it throw.
 */
export function lens(r: Reply): string {
  const clipped = clipDepth(r);
  const frame = isObject(clipped) ? clipped : {};
  const more = moreOf(frame);
  const out =
    more && kindFits(frame)
      ? bodyLines(frame as unknown as Reply)
      : unknownLines(frame, more !== null);

  if (more) {
    out.push(...moreLines(more));
  }

  return out.join('\n');
}
