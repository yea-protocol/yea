/**
 * The short labels the playground puts on an exchange: a reply's colour by protocol state,
 * and one-line summaries of the request and the reply.
 */
import type { FinalReply, Request } from '@yea-protocol/sdk';

/** Green: done. Amber: waiting on a choice. Red: failed. */
export type Tone = 'green' | 'amber' | 'red' | 'plain';

/** Whether a reply is an error asking the human to approve. */
export const needsConsent = (r: FinalReply) =>
  r.kind === 'ERROR' && r.code === 'consent_required';

export function toneOf(r: FinalReply): Tone {
  switch (r.kind) {
    case 'RECEIPT':
      return 'green';
    case 'ERROR':
      return needsConsent(r) ? 'amber' : 'red';
    case 'PROPOSALS':
    case 'CLARIFY':
      return 'amber';
    default:
      return 'plain';
  }
}

export function requestSummary(r: Request): string {
  switch (r.verb) {
    case 'ASK':
    case 'INTENT':
      return `${r.verb} ${r.capability}`;
    case 'COMMIT':
      return `COMMIT ${r.proposal}`;
    case 'UNDO':
      return `UNDO ${r.receipt}`;
    case 'EXPAND':
      return `EXPAND ${r.handle}`;
    default:
      return r.verb;
  }
}

export function replySummary(r: FinalReply): string {
  if (r.kind === 'ERROR') {
    return r.code;
  }

  if (r.kind !== 'RECEIPT') {
    return r.kind;
  }

  if (r.replay) {
    return 'RECEIPT (replay)';
  }

  if (r.auto) {
    return 'RECEIPT (auto)';
  }

  return r.receipt.undoes ? 'RECEIPT (undo)' : 'RECEIPT';
}
