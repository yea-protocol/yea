/**
 * The commit ledger (GLOSSARY.md): each proposal's life, proposed, committed, receipted, undone
 * or expired, and the usage ledger its `total` limits count against. A COMMIT is a replay first
 * (§4.4); otherwise the ledger evaluates the grant with its limits and reserves in the same
 * synchronous step (ADR-0002). It applies a plan at most once and reverts it at most once.
 */
import { consentRequest } from '../consent.js';
import { fix, YeaError } from '../errors.js';
import { replyFrame } from '../frames.js';
import type { Reservation } from '../store.js';
import type { ErrorReply, Event, FinalReply, ReceiptReply } from '../types.js';
import { type AutoReplay, AutoReplies } from './commit-ledger/autos.js';
import {
  type Admit,
  type Answer,
  type Commit,
  type LedgerOptions,
  type Records,
  receiptFor,
  type StoredProposal,
  type StoredReceipt,
  type Undo,
  type Used,
} from './commit-ledger/records.js';
import { sweep } from './commit-ledger/sweep.js';
import { checkUndoable, revert } from './commit-ledger/undo.js';
import { UsageLedger } from './commit-ledger/usage.js';
import { errorReply, eventFrame, replayOf } from './replies.js';

export type { AutoReplay } from './commit-ledger/autos.js';

export type {
  Admit,
  Admitted,
  Answer,
  Commit,
  LedgerOptions,
  StoredProposal,
  StoredReceipt,
  Undo,
  Used,
} from './commit-ledger/records.js';

type Outcome = ReceiptReply | ErrorReply;

/** A sweep runs on every 100th INTENT, or on each one while this many proposals are kept. */
const SWEEP_EVERY = 100;
const SWEEP_AT = 5000;

export class CommitLedger {
  private readonly records: Records = {
    proposals: new Map(),
    runs: new Map(),
    receipts: new Map(),
    undos: new Map(),
  };

  private readonly autos = new AutoReplies();
  private readonly usage = new UsageLedger();
  private readonly used: Used = (key) => this.usage.used(key);
  private intents = 0;

  constructor(private readonly svc: LedgerOptions) {}

  /** Keep an INTENT's proposals; every so often, sweep first what has expired. */
  propose(stored: StoredProposal[]) {
    for (const s of stored) {
      this.records.proposals.set(s.proposal.id, s);
    }

    if (
      ++this.intents % SWEEP_EVERY === 0 ||
      this.records.proposals.size >= SWEEP_AT
    ) {
      this.sweep();
    }
  }

  proposal(id: string): StoredProposal | undefined {
    return this.records.proposals.get(id);
  }

  /** A receipt the ledger issued for a commit (never an undo receipt). */
  receipt(id: string): StoredReceipt | undefined {
    return this.records.receipts.get(id);
  }

  /**
   * Commit a proposal once (SPEC §4.4). A repeat gets the original outcome, for the same
   * principal only, with no limit re-evaluated. Otherwise the grant's limits are evaluated, and
   * the reservation follows with no await in between, so concurrent commits can't overshoot a
   * `total`. Throws the error to reply with when the proposal expired or no grant admits it.
   */
  async commit(req: Commit, emit: (e: Event) => void): Promise<Outcome> {
    const { proposal } = req.stored;
    const prior = this.records.runs.get(proposal.id);

    if (prior !== undefined) {
      return this.replay(prior, req);
    }

    const admitted = await req.admit(proposal, this.used);

    // Another COMMIT of this proposal may have started while this one was admitted.
    if (this.records.runs.has(proposal.id)) {
      return this.commit(req, emit);
    }

    if (admitted instanceof YeaError) {
      throw admitted;
    }

    if (this.svc.now() >= proposal.expires) {
      throw new YeaError('expired', 'this proposal has expired', {
        fix: [fix('send INTENT again to get a fresh proposal')],
      });
    }

    const r = this.usage.reserveAll(proposal, admitted.totals);

    if ('over' in r) {
      throw new YeaError(
        'consent_required',
        `${r.over.of} would pass a total limit (other commits are in flight); your principal must approve this exact proposal`,
        { consent: consentRequest(proposal, this.svc.id, admitted.iss) },
      );
    }

    return this.start(req.stored, admitted.iss, r.held, { re: req.id, emit });
  }

  /**
   * Commit an auto INTENT's fresh proposal now if it is undoable and its grant admits it
   * outright (SPEC §4.3.1): the same step as a COMMIT. Null leaves it a proposal. An undo window
   * of 0 can never be used, so it doesn't count.
   */
  async autoCommit(
    stored: StoredProposal,
    admit: Admit,
    answer: Answer,
  ): Promise<Outcome | null> {
    if ((stored.proposal.undo?.window ?? 0) <= 0) {
      return null;
    }

    const admitted = await admit(stored.proposal, this.used);

    if (admitted instanceof YeaError) {
      return null;
    }

    // Over a `total` here means a commit in flight took the room: a proposal, as with no grant.
    const r = this.usage.reserveAll(stored.proposal, admitted.totals);

    return 'over' in r
      ? null
      : this.start(stored, admitted.iss, r.held, answer);
  }

  /** Revert a receipt's plan once, inside its undo window (SPEC §4.5); a repeat gets the original outcome. */
  async undo(req: Undo, emit: (e: Event) => void): Promise<Outcome> {
    const { stored } = req;
    const { receipt } = stored;
    const prior = this.records.undos.get(receipt.id);

    if (prior !== undefined) {
      return replayOf(await prior, req.id);
    }

    checkUndoable(stored, this.svc.now());

    // Stored before revert starts, so a synchronous throw from `plan.revert` can clear it (#187).
    const run = Promise.resolve()
      .then(() =>
        revert(stored, {
          re: req.id,
          principal: req.principal,
          at: this.svc.now,
          emit,
        }),
      )
      .catch((e: unknown) => {
        this.records.undos.delete(receipt.id); // a failed undo may be retried

        return errorReply(this.svc.opts, req.id, e);
      });

    this.records.undos.set(receipt.id, run);

    return run;
  }

  /** Answer an auto INTENT once per replay key (SPEC §4.3.1): a repeat gets the original reply. */
  answerOnce(
    replay: AutoReplay,
    re: string,
    answer: () => Promise<FinalReply>,
  ): Promise<FinalReply> {
    return this.autos.answerOnce(replay, re, answer, this.svc.now());
  }

  /** Forget expired proposals, receipts a day past their undo window, and stale auto replies. */
  sweep() {
    const now = this.svc.now();

    sweep(this.records, now);
    this.autos.forget(now);
  }

  /** A replay of a commit (SPEC §4.4): only for the principal whose grant committed it. */
  private async replay(prior: Promise<Outcome>, req: Commit): Promise<Outcome> {
    const out = await prior;

    if (
      out.kind === 'RECEIPT' &&
      this.records.receipts.get(out.receipt.id)?.principal !== req.principal
    ) {
      throw new YeaError(
        'forbidden',
        'this proposal was committed by a different principal',
      );
    }

    return replayOf(out, req.id);
  }

  /**
   * Start the run of a proposal whose reservations are held. It is stored before apply starts:
   * a synchronous throw from `plan.apply` then finds its entry to delete, so a retry runs apply
   * again (#187).
   */
  private start(
    stored: StoredProposal,
    principal: string,
    held: Reservation[],
    answer: Answer,
  ): Promise<Outcome> {
    const run = Promise.resolve().then(() =>
      this.apply(stored, principal, held, answer),
    );

    this.records.runs.set(stored.proposal.id, run);

    return run;
  }

  /** Perform the plan's effects and keep the receipt; a failure frees the proposal and its reservations. */
  private async apply(
    { proposal, plan }: StoredProposal,
    principal: string,
    held: Reservation[],
    { re, emit }: Answer,
  ): Promise<Outcome> {
    try {
      const result = await plan.apply({
        principal,
        progress: (message, progress, data) =>
          emit(eventFrame(re, message, progress, data)),
      });
      const receipt = receiptFor(proposal, result, this.svc.now());

      this.records.receipts.set(receipt.id, {
        receipt,
        plan,
        result,
        principal,
      });

      for (const h of held) {
        this.usage.settle(h);
      }

      return replyFrame(re, 'RECEIPT', { receipt });
    } catch (e) {
      this.records.runs.delete(proposal.id); // a failed commit may be retried

      for (const h of held) {
        this.usage.release(h);
      }

      return errorReply(this.svc.opts, re, e);
    }
  }
}
