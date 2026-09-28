/** The INTENT verb: plan a capability into hashed proposals, committing an auto INTENT at once when a grant allows it. */
import { fit } from '../budget.js';
import { proposalHash, randomId } from '../crypto.js';
import { fix, YeaError } from '../errors.js';
import { replyFrame } from '../frames.js';
import type { IntentDef, Plan } from '../plan.js';
import { autoTarget } from '../proof.js';
import { resolveRisk } from '../risk.js';
import type { Event, FinalReply, Intent, Proposal } from '../types.js';
import { isUses, type Uses } from '../uses.js';
import { validateParams } from '../validate.js';
import { unknownCapability } from './capabilities.js';
import type { Executor } from './execute.js';
import { replayOf, verifiedKey } from './replies.js';
import { DAY, type ServiceState, type StoredProposal } from './state.js';
import type { Sweeper } from './sweep.js';

interface IntentRun {
  def: IntentDef;
  req: Intent;
  budget: number;
  emit: (e: Event) => void;
  principal: string | null;
}

export class IntentHandler {
  constructor(
    private readonly state: Pick<
      ServiceState,
      | 'opts'
      | 'asks'
      | 'intents'
      | 'proposals'
      | 'autoSeen'
      | 'authorizer'
      | 'handles'
      | 'now'
    >,
    private readonly executor: Executor,
    private readonly sweeper: Sweeper,
  ) {}

  async onIntent(
    req: Intent,
    budget: number,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const def =
      this.state.intents.get(req.capability) ??
      unknownCapability(this.state, req.capability, 'intent');

    validateParams(def.params, req.params ?? {});

    const auth = await this.state.authorizer.authorize(req, {
      verb: 'INTENT',
      capability: req.capability,
      target: req.auto ? autoTarget(req.capability, req.id) : req.capability,
    });
    const principal = auth?.iss ?? null;
    // A replayed auto INTENT (same holder key + request id) gets the original reply, never a second commit.
    const auto = autoReplayKey(req);

    if (auto) {
      const prior = this.state.autoSeen.get(auto.key);

      if (prior && prior.exp > this.state.now()) {
        const r = await prior.reply;

        return r.kind === 'RECEIPT' ? replayOf(r, req.id) : r;
      }
    }

    const reply = this.planIntent({ def, req, budget, emit, principal });

    if (auto) {
      this.rememberAuto(auto.key, reply, auto.proofTs);
    }

    return reply;
  }

  private rememberAuto(
    key: string,
    reply: Promise<FinalReply>,
    proofTs: number,
  ) {
    // outlive every proof that could carry this frame id: proofs are valid for ±300s around ts
    this.state.autoSeen.set(key, {
      reply,
      exp: Math.max(this.state.now(), proofTs) + 900,
    });

    if (this.state.autoSeen.size > 10_000) {
      for (const [k, v] of this.state.autoSeen) {
        if (v.exp <= this.state.now()) {
          this.state.autoSeen.delete(k);
        }
      }
    }
  }

  private async planIntent(run: IntentRun): Promise<FinalReply> {
    const { def, req, budget, principal } = run;
    const out = await def.plan({
      params: req.params ?? {},
      goal: req.goal,
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
        requester: verifiedKey(req),
        created: now,
      };

      this.state.proposals.set(proposal.id, s);
      stored.push(s);
    }

    this.sweeper.sweep(now);

    const committed = req.auto ? await this.autoCommit(stored[0], run) : null;

    if (committed) {
      return committed;
    }

    return fit(
      replyFrame(req.id, 'PROPOSALS', {
        proposals: stored.map((s) => s.proposal),
      }),
      budget,
      this.state.handles,
      verifiedKey(req),
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

  /** Commit an auto INTENT's proposal now if a grant allows it outright; null leaves it a proposal. */
  private async autoCommit(
    stored: StoredProposal,
    run: IntentRun,
  ): Promise<FinalReply | null> {
    const ok = await this.state.authorizer.autoAuth(run.req, stored.proposal);

    if (!ok || (stored.principal && stored.principal !== ok.iss)) {
      return null;
    }

    const out = await this.executor.execute(stored, ok, run.req.id, run.emit);

    return out.kind === 'RECEIPT'
      ? fit(
          { ...out, auto: true },
          run.budget,
          this.state.handles,
          verifiedKey(run.req),
        )
      : out;
  }
}

/** Replay key for an auto INTENT: the holder key (proof verified by authorize()) plus the request id. */
function autoReplayKey(req: Intent): { key: string; proofTs: number } | null {
  if (!req.auto || !req.grants?.length || !req.proof) {
    return null;
  }

  return { key: `${req.proof.key}:${req.id}`, proofTs: req.proof.ts };
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
