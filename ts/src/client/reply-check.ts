/** Turning a reply with a malformed proposal or receipt (SPEC §5.1) into a local `bad_frame` error. */
import { isRisk } from '../risk.js';
import type { FinalReply, Proposal, Receipt } from '../types.js';
import { isUses } from '../uses.js';

/** What is malformed about a proposal or receipt (SPEC §5.1), or null if nothing is. */
function malformedPart(x: Proposal | Receipt, isProposal: boolean) {
  if (x.uses !== undefined && !isUses(x.uses)) {
    return 'a malformed uses';
  }

  // Only a proposal carries a risk.
  return isProposal && !isRisk((x as Proposal).risk) ? 'an unknown risk' : null;
}

/**
 * SPEC §5.1: a proposal with a malformed `uses` or an unknown `risk`, or a receipt with a
 * malformed `uses`, is invalid, so the reply becomes a local `bad_frame` error instead of
 * something a model or a person might act on.
 */
export function rejectMalformed(reply: FinalReply): FinalReply {
  const isProposal = reply.kind === 'PROPOSALS';
  const items: (Proposal | Receipt)[] = isProposal
    ? reply.proposals
    : reply.kind === 'RECEIPT'
      ? [reply.receipt]
      : [];

  for (const x of items) {
    const why = malformedPart(x, isProposal);

    if (why) {
      return {
        yea: 1,
        id: reply.id,
        re: reply.re,
        kind: 'ERROR',
        code: 'bad_frame',
        message: `${isProposal ? 'proposal' : 'receipt'} ${x.id} from the service has ${why}, so it was ignored`,
      };
    }
  }

  return reply;
}
