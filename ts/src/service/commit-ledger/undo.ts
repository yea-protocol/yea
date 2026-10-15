/** Reverting a receipt's plan (SPEC §4.5): inside its undo window, run `revert`, then issue the undo receipt with its effects inverted. */
import { randomId } from '../../crypto.js';
import { YeaError } from '../../errors.js';
import { replyFrame } from '../../frames.js';
import type { Effect, Event, Receipt, ReceiptReply } from '../../types.js';
import { eventFrame } from '../replies.js';
import type { StoredReceipt } from './records.js';

/** What a revert runs for: the frame it answers, the principal undoing, and where EVENTs go. */
export interface RevertCtx {
  re: string;
  principal: string;
  at: () => number;
  emit: (e: Event) => void;
}

/** Throws unless the receipt's plan can be reverted, and its undo window is still open at `now`. */
export function checkUndoable({ receipt, plan }: StoredReceipt, now: number) {
  if (!receipt.undo || !plan.revert) {
    throw new YeaError('forbidden', 'this action is irreversible');
  }

  if (now > receipt.undo.until) {
    throw new YeaError(
      'expired',
      `the undo window closed at ${new Date(receipt.undo.until * 1000).toISOString()}`,
    );
  }
}

/** Reverse a receipt's effects and issue the undo receipt; throws what `revert` throws. */
export async function revert(
  stored: StoredReceipt,
  ctx: RevertCtx,
): Promise<ReceiptReply> {
  const { receipt, plan } = stored;

  // checkUndoable has refused a plan without `revert`.
  await plan.revert?.({
    principal: ctx.principal,
    result: stored.result,
    progress: (message, progress) =>
      ctx.emit(eventFrame(ctx.re, message, progress)),
  });

  const undo: Receipt = {
    id: randomId('r', 6),
    proposal: receipt.proposal,
    capability: receipt.capability,
    summary: receipt.summary,
    at: ctx.at(),
    effects: receipt.effects.map(invertEffect),
    undo: null,
    undoes: receipt.id,
  };

  return replyFrame(ctx.re, 'RECEIPT', { receipt: undo });
}

const INVERSE_OP: Record<Effect['op'], Effect['op']> = {
  create: 'delete',
  delete: 'create',
  update: 'update',
  send: 'other',
  other: 'other',
};

/** An update with `from` and `to` swapped; a side the original left out stays out (SPEC §4.5). */
function swapSides({ from, to, ...rest }: Effect): Effect {
  return {
    ...rest,
    ...(to !== undefined ? { from: to } : {}),
    ...(from !== undefined ? { to: from } : {}),
  };
}

/** The effect an undo receipt reports for reversing `e`. */
function invertEffect(e: Effect): Effect {
  switch (e.op) {
    case 'update':
      return swapSides(e);
    case 'send':
      return {
        op: 'other',
        target: e.target,
        detail: 'cannot unsend; follow-up sent if supported',
      };
    default:
      return { ...e, op: INVERSE_OP[e.op] };
  }
}
