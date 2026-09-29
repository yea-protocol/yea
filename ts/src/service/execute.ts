/** Carries out an authorized commit: reserve its uses against the `total` ledger, apply the plan, record the receipt. */
import type { Authorized } from '../authorize.js';
import { consentRequest } from '../consent.js';
import { randomId } from '../crypto.js';
import { YeaError } from '../errors.js';
import { replyFrame } from '../frames.js';
import { usedOf } from '../grants.js';
import type { CommitCtx } from '../plan.js';
import { ledgerId } from '../store.js';
import type {
  ErrorReply,
  Event,
  Proposal,
  Receipt,
  ReceiptReply,
} from '../types.js';
import { exact } from '../uses.js';
import { errorReply, eventFrame } from './replies.js';
import type { ServiceState, StoredProposal } from './state.js';

export class Executor {
  constructor(
    private readonly state: Pick<
      ServiceState,
      'id' | 'opts' | 'used' | 'commits' | 'receipts' | 'now'
    >,
  ) {}

  execute(
    stored: StoredProposal,
    auth: Authorized,
    reqId: string,
    emit: (e: Event) => void,
  ): Promise<ReceiptReply | ErrorReply> {
    const { proposal } = stored;
    // Reserve totals synchronously, before any await, so concurrent commits can't overshoot a limit.
    const over = auth.totals.find((t) => {
      const q = usedOf(proposal.uses, t.of);
      const used =
        this.state.used.get(ledgerId({ block: t.id, of: t.of })) ?? 0n;

      return q && used + exact(q) > t.max;
    });

    if (over) {
      return Promise.resolve(
        errorReply(
          this.state.opts,
          reqId,
          new YeaError(
            'consent_required',
            `${over.of} would pass a total limit (other commits are in flight); your principal must approve this exact proposal`,
            { consent: consentRequest(proposal, this.state.id, auth.iss) },
          ),
        ),
      );
    }

    this.reserve(auth, proposal, 1n);

    // Store the run before apply starts: a synchronous throw from `plan.apply` then finds its
    // entry to delete, so a retry runs apply again instead of replaying the ERROR.
    const run = Promise.resolve().then(() =>
      this.apply(stored, auth, reqId, emit),
    );

    this.state.commits.set(proposal.id, run);

    return run;
  }

  /**
   * Count the proposal's uses against every `total` the grant draws on, once per block and
   * measure even when a block repeats a limit; `sign` -1n releases them.
   */
  private reserve(auth: Authorized, proposal: Proposal, sign: 1n | -1n) {
    const totals = new Map(
      auth.totals.map((t) => [ledgerId({ block: t.id, of: t.of }), t.of]),
    );

    for (const [key, of] of totals) {
      const q = usedOf(proposal.uses, of);

      if (q) {
        this.state.used.set(
          key,
          (this.state.used.get(key) ?? 0n) + sign * exact(q),
        );
      }
    }
  }

  /** Perform the plan's effects and record the receipt; a failure frees the proposal and its spend. */
  private async apply(
    stored: StoredProposal,
    auth: Authorized,
    reqId: string,
    emit: (e: Event) => void,
  ): Promise<ReceiptReply | ErrorReply> {
    const { proposal, plan } = stored;
    const ctx: CommitCtx = {
      principal: auth.iss,
      progress: (message, progress, data) =>
        emit(eventFrame(reqId, message, progress, data)),
    };

    try {
      const result = await plan.apply(ctx);
      const receipt = receiptFor(proposal, result, this.state.now());

      this.state.receipts.set(receipt.id, {
        receipt,
        plan,
        result,
        principal: auth.iss,
      });

      return replyFrame(reqId, 'RECEIPT', { receipt });
    } catch (e) {
      this.state.commits.delete(proposal.id); // failed commits may be retried
      this.reserve(auth, proposal, -1n);

      return errorReply(this.state.opts, reqId, e);
    }
  }
}

function receiptFor(proposal: Proposal, result: unknown, at: number): Receipt {
  return {
    id: randomId('r', 6),
    proposal: proposal.id,
    capability: proposal.capability,
    summary: proposal.summary,
    at,
    effects: proposal.effects,
    ...(proposal.uses ? { uses: proposal.uses } : {}),
    undo: proposal.undo ? { until: at + proposal.undo.window } : null,
    ...(result !== undefined && result !== null ? { result } : {}),
  };
}
