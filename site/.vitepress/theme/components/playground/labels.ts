/**
 * The short labels the playground puts on an exchange: a reply's colour by protocol state,
 * and one-line summaries of the request and the reply.
 */
import type { FinalReply, Request } from '@yea-protocol/sdk';
import { declinedLine } from '../proposal-facts.ts';
import type { Exchange } from './model';
import type { Declined } from './use-consent';

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

/** What came back, as History says it: an exchange the human declined is "declined". */
export const outcomeOf = (
  x: Pick<Exchange, 'n' | 'reply'>,
  declined: Declined,
): string => (declined.has(x.n) ? 'declined' : replySummary(x.reply));

/**
 * The exchange in one line for the live region: its number, what was sent and what came back.
 * A declined one adds the declined line, so a Decline is announced too.
 */
export function statusLine(
  x: Pick<Exchange, 'n' | 'request' | 'reply'>,
  declined: Declined,
): string {
  const line = `${x.n}. ${requestSummary(x.request)}: ${outcomeOf(x, declined)}`;
  const p = declined.get(x.n);

  return p ? `${line}. ${declinedLine(p.expires)}` : line;
}
