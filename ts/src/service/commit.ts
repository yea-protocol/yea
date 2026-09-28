/** The COMMIT verb (SPEC §4.4): check the hash, requester and grant, then execute once; repeats get the original outcome. */
import type { Authorized, AuthScope } from '../authorize.js';
import { fit } from '../budget.js';
import { fix, YeaError } from '../errors.js';
import type { Event, FinalReply, Request } from '../types.js';
import type { Executor } from './execute.js';
import { replayOf } from './replies.js';
import type { ServiceState, StoredProposal } from './state.js';

export class CommitHandler {
  constructor(
    private readonly state: Pick<
      ServiceState,
      'proposals' | 'commits' | 'receipts' | 'authorizer' | 'handles' | 'now'
    >,
    private readonly executor: Executor,
  ) {}

  async onCommit(
    req: Request & { verb: 'COMMIT' },
    budget: number,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const stored = this.state.proposals.get(req.proposal);

    if (!stored) {
      throw new YeaError(
        'not_found',
        `no proposal ${JSON.stringify(req.proposal)}`,
        { fix: [fix('send INTENT again to get fresh proposals')] },
      );
    }

    const { proposal } = stored;

    if (req.hash !== proposal.hash) {
      throw new YeaError(
        'conflict',
        'hash does not match the proposal; you would commit something other than what you saw',
        { fix: [fix('re-read the proposal, or send INTENT again')] },
      );
    }

    const scope: AuthScope = {
      verb: 'COMMIT',
      capability: proposal.capability,
      target: proposal.hash,
      proposal,
      principal: stored.principal,
    };
    const existing = this.state.commits.get(proposal.id);

    if (existing !== undefined) {
      // Idempotent replay (SPEC §4.4): same principal and requester only; limits already spent don't block it.
      const auth = await this.state.authorizer.authorizeRequired(req, {
        ...scope,
        replay: true,
      });

      this.checkRequester(stored, auth);

      const prior = await existing;

      if (
        prior.kind === 'RECEIPT' &&
        this.state.receipts.get(prior.receipt.id)?.principal !== auth.iss
      ) {
        throw new YeaError(
          'forbidden',
          'this proposal was committed by a different principal',
        );
      }

      return replayOf(prior, req.id);
    }

    const auth = await this.state.authorizer
      .authorizeRequired(req, scope)
      .catch((e) => {
        if (this.state.commits.has(proposal.id)) {
          return null; // it was committed while we waited; answer as a replay below
        }

        throw e;
      });

    // Another COMMIT of this proposal may have started while this one was being authorized.
    if (!auth || this.state.commits.has(proposal.id)) {
      return this.onCommit(req, budget, emit);
    }

    this.checkRequester(stored, auth);

    if (this.state.now() >= proposal.expires) {
      throw new YeaError('expired', 'this proposal has expired', {
        fix: [fix('send INTENT again to get a fresh proposal')],
      });
    }

    const out = await this.executor.execute(stored, auth, req.id, emit);

    return out.kind === 'RECEIPT'
      ? fit(out, budget, this.state.handles, auth.holder)
      : out;
  }

  /** Only the agent that asked for a proposal (with a verified proof) may commit it. */
  private checkRequester(stored: StoredProposal, auth: Authorized) {
    if (!stored.requester) {
      throw new YeaError(
        'forbidden',
        "this proposal came from an anonymous INTENT and can't be committed",
        {
          fix: [
            fix('send INTENT again with your grant, then commit that proposal'),
          ],
        },
      );
    }

    if (stored.requester !== auth.holder) {
      throw new YeaError(
        'forbidden',
        'only the agent that requested this proposal can commit it',
        { fix: [fix('send INTENT yourself, then commit your own proposal')] },
      );
    }
  }
}
