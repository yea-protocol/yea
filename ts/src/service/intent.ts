/** The INTENT verb: plan a capability into hashed proposals for the commit ledger, committing an auto INTENT at once when a grant allows it. */
import { fit } from '../budget.js';
import { proposalHash, randomId } from '../crypto.js';
import { fix, YeaError } from '../errors.js';
import { replyFrame } from '../frames.js';
import type { IntentDef, Plan } from '../plan.js';
import { resolveRisk } from '../risk.js';
import type { Event, FinalReply, Proposal } from '../types.js';
import { isUses, type Uses } from '../uses.js';
import { DAY } from '../util.js';
import type { Admit, StoredProposal } from './commit-ledger.js';
import type { ServiceState } from './state.js';
import type { VerifiedIntent } from './verified-request.js';

export class IntentHandler {
  constructor(
    private readonly state: Pick<
      ServiceState,
      'opts' | 'ledger' | 'handles' | 'now'
    >,
  ) {}

  /** A repeated auto INTENT (same holder key and frame id) gets the original reply, never a second commit. */
  onIntent(req: VerifiedIntent, emit: (e: Event) => void): Promise<FinalReply> {
    const replay = req.auto?.replay;

    return replay
      ? this.state.ledger.answerOnce(replay, req.id, () =>
          this.planIntent(req, emit),
        )
      : this.planIntent(req, emit);
  }

  private async planIntent(
    req: VerifiedIntent,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const { def, principal } = req;
    const out = await def.plan({
      params: req.params,
      goal: req.goal ?? undefined,
      principal,
    });

    if (out && 'clarify' in out) {
      return replyFrame(req.id, 'CLARIFY', out.clarify);
    }

    const plans = Array.isArray(out) ? out : [out];

    if (!plans.length) {
      throw new YeaError('not_found', 'no way to satisfy this intent', {
        fix: [fix('relax the constraints and try again')],
      });
    }

    const now = this.state.now();
    const stored: StoredProposal[] = [];

    for (const plan of plans) {
      const proposal = await this.propose(plan, def, req.capability, now);
      const s: StoredProposal = {
        proposal,
        plan,
        principal,
        // Only the holder key of a verified proof may commit it, and replies are for it alone.
        requester: req.holder,
        created: now,
      };

      stored.push(s);
    }

    this.state.ledger.propose(stored);

    const committed = req.auto?.admit
      ? await this.autoCommit(stored[0], req, req.auto.admit, emit)
      : null;

    if (committed) {
      return committed;
    }

    return fit(
      replyFrame(req.id, 'PROPOSALS', {
        proposals: stored.map((s) => s.proposal),
      }),
      req.budget,
      this.state.handles,
      req.holder,
    );
  }

  /** Turn a plan into a hashed proposal, filling defaults and rounding expiry up to the minute. */
  private async propose(
    plan: Plan,
    def: IntentDef,
    capability: string,
    now: number,
  ): Promise<Proposal> {
    const window = plan.revert ? (plan.undoWindow ?? DAY) : null;
    const p: Omit<Proposal, 'hash'> = {
      id: randomId('p', 6),
      capability,
      summary: plan.summary,
      effects: plan.effects,
      ...usesOf(plan),
      risk: resolveRisk('low', plan.risk, def.risk),
      undo: window === null ? null : { window },
      expires:
        Math.ceil(
          (now + (plan.expiresIn ?? this.state.opts.proposalTtl ?? 600)) / 60,
        ) * 60,
      ...(plan.data !== undefined ? { data: plan.data } : {}),
    };

    return { ...p, hash: await proposalHash(p) } as Proposal;
  }

  /** Commit an auto INTENT's first proposal if the ledger admits it outright; null leaves it a proposal. */
  private async autoCommit(
    stored: StoredProposal,
    req: VerifiedIntent,
    admit: Admit,
    emit: (e: Event) => void,
  ): Promise<FinalReply | null> {
    const out = await this.state.ledger.autoCommit(stored, admit, {
      re: req.id,
      emit,
    });

    return out?.kind === 'RECEIPT'
      ? fit({ ...out, auto: true }, req.budget, this.state.handles, req.holder)
      : out;
  }
}

/** The plan's `uses` for its proposal: omitted when empty, and rejected when malformed. */
function usesOf(plan: Plan): { uses?: Uses } {
  if (plan.uses === undefined) {
    return {};
  }

  if (!isUses(plan.uses)) {
    throw new Error(`plan has a malformed uses: ${JSON.stringify(plan.uses)}`);
  }

  // A copy, so a plan that changes its object after hashing can't change what is reserved.
  return Object.keys(plan.uses).length
    ? { uses: structuredClone(plan.uses) }
    : {};
}
