/** The UNDO verb: revert a receipt's plan inside its undo window, once, and issue the undo receipt. */
import { fit } from '../budget.js';
import { randomId } from '../crypto.js';
import { YeaError } from '../errors.js';
import { replyFrame } from '../frames.js';
import type {
  Effect,
  ErrorReply,
  Event,
  FinalReply,
  Receipt,
  ReceiptReply,
} from '../types.js';
import { errorReply, eventFrame, replayOf } from './replies.js';
import type { ServiceState } from './state.js';
import type { VerifiedUndo } from './verified-request.js';

export class UndoHandler {
  constructor(
    private readonly state: Pick<ServiceState, 'opts' | 'handles' | 'now'>,
  ) {}

  /** `req` names an undoable receipt, under a grant from the principal who committed it. */
  async onUndo(
    req: VerifiedUndo,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const { stored } = req;

    if (stored.undone !== undefined) {
      return replayOf(await stored.undone, req.id);
    }

    const { receipt, plan } = stored;

    if (!receipt.undo || !plan.revert) {
      throw new YeaError('forbidden', 'this action is irreversible');
    }

    if (this.state.now() > receipt.undo.until) {
      throw new YeaError(
        'expired',
        `the undo window closed at ${new Date(receipt.undo.until * 1000).toISOString()}`,
      );
    }

    // Stored before revert starts, so a synchronous throw from `plan.revert` can clear it (#187).
    stored.undone = Promise.resolve().then(() => this.revert(req, emit));

    const out = await stored.undone;

    return out.kind === 'RECEIPT'
      ? fit(out, req.budget, this.state.handles, req.holder)
      : out;
  }

  /** Reverse a receipt's effects and issue the undo receipt; a failure allows another attempt. */
  private async revert(
    req: VerifiedUndo,
    emit: (e: Event) => void,
  ): Promise<ReceiptReply | ErrorReply> {
    const { stored, id: reqId } = req;
    const { receipt, plan } = stored;

    try {
      // onUndo only gets here for plans that have `revert`.
      await plan.revert?.({
        principal: req.principal,
        result: stored.result,
        progress: (message, progress) =>
          emit(eventFrame(reqId, message, progress)),
      });

      const undo: Receipt = {
        id: randomId('r', 6),
        proposal: receipt.proposal,
        capability: receipt.capability,
        summary: receipt.summary,
        at: this.state.now(),
        effects: receipt.effects.map(invertEffect),
        undo: null,
        undoes: receipt.id,
      };

      return replyFrame(reqId, 'RECEIPT', { receipt: undo });
    } catch (e) {
      stored.undone = undefined;

      return errorReply(this.state.opts, reqId, e);
    }
  }
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
