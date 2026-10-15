/** The COMMIT verb (SPEC §4.4): check the grant admits the proposal, then execute once; repeats get the original outcome. */
import { fit } from '../budget.js';
import { fix, YeaError } from '../errors.js';
import type { Event, FinalReply } from '../types.js';
import type { Executor } from './execute.js';
import { replayOf } from './replies.js';
import type { ServiceState } from './state.js';
import type { Authorized, VerifiedCommit } from './verified-request.js';

export class CommitHandler {
  constructor(
    private readonly state: Pick<
      ServiceState,
      'commits' | 'receipts' | 'handles' | 'now'
    >,
    private readonly executor: Executor,
  ) {}

  /** `req` comes from the proposal's requester, under a grant from its principal. */
  async onCommit(
    req: VerifiedCommit,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const { proposal } = req.stored;
    const existing = this.state.commits.get(proposal.id);

    if (existing !== undefined) {
      // Idempotent replay (SPEC §4.4): limits already spent don't block it.
      const prior = await existing;

      if (
        prior.kind === 'RECEIPT' &&
        this.state.receipts.get(prior.receipt.id)?.principal !== req.principal
      ) {
        throw new YeaError(
          'forbidden',
          'this proposal was committed by a different principal',
        );
      }

      return replayOf(prior, req.id);
    }

    const auth: Authorized | null = await req.limits().catch((e) => {
      if (this.state.commits.has(proposal.id)) {
        return null; // it was committed while we waited; answer as a replay below
      }

      throw e;
    });

    // Another COMMIT of this proposal may have started while this one was being authorized.
    if (!auth || this.state.commits.has(proposal.id)) {
      return this.onCommit(req, emit);
    }

    if (this.state.now() >= proposal.expires) {
      throw new YeaError('expired', 'this proposal has expired', {
        fix: [fix('send INTENT again to get a fresh proposal')],
      });
    }

    const out = await this.executor.execute(req.stored, auth, req.id, emit);

    return out.kind === 'RECEIPT'
      ? fit(out, req.budget, this.state.handles, req.holder)
      : out;
  }
}
