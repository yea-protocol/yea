/** The UNDO verb: revert a receipt's plan inside its undo window, once, and issue the undo receipt. */
import type { Authorized } from '../authorize.js';
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
  Request,
} from '../types.js';
import { errorReply, eventFrame, replayOf } from './replies.js';
import type { ServiceState, StoredReceipt } from './state.js';

export class UndoHandler {
  constructor(
    private readonly state: Pick<
      ServiceState,
      'opts' | 'receipts' | 'authorizer' | 'handles' | 'now'
    >,
  ) {}

  async onUndo(
    req: Request & { verb: 'UNDO' },
    budget: number,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const stored = this.state.receipts.get(req.receipt);

    if (!stored || stored.receipt.undoes) {
      throw new YeaError(
        'not_found',
        `no undoable receipt ${JSON.stringify(req.receipt ?? null)}`,
      );
    }

    const auth = await this.state.authorizer.authorizeRequired(req, {
      verb: 'UNDO',
      capability: stored.receipt.capability,
      target: req.receipt,
    });

    if (auth.iss !== stored.principal) {
      throw new YeaError(
        'forbidden',
        'only the principal who committed this can undo it',
      );
    }

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
    stored.undone = Promise.resolve().then(() =>
      this.revert(stored, auth, req.id, emit),
    );

    const out = await stored.undone;

    return out.kind === 'RECEIPT'
      ? fit(out, budget, this.state.handles, auth.holder)
      : out;
  }

  /** Reverse a receipt's effects and issue the undo receipt; a failure allows another attempt. */
  private async revert(
    stored: StoredReceipt,
    auth: Authorized,
    reqId: string,
    emit: (e: Event) => void,
  ): Promise<ReceiptReply | ErrorReply> {
    const { receipt, plan } = stored;

    try {
      // onUndo only gets here for plans that have `revert`.
      await plan.revert?.({
        principal: auth.iss,
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
