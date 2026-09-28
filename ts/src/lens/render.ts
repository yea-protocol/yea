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
      return []; // a frame of unknown kind (untyped caller) renders only its `more` lines
  }
}

/** Render a reply frame as Lens (SPEC §9.2). */
export function lens(r: Reply): string {
  const out = bodyLines(r);

  if ('more' in r) {
    out.push(...moreLines(r.more));
  }

  return out.join('\n');
}
