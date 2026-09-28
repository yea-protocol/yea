/**
 * Build a YEA service. Transport-independent: `handle(frame)` turns a request frame
 * into its final reply (emitting EVENTs along the way). Transports live in node.ts / http.ts.
 */
import {
  type Authorized,
  Authorizer,
  type AuthScope,
  autoTarget,
  consentRequest,
} from './authorize.js';
import { fit, type HandleStore, MemoryHandleStore } from './budget.js';
import { proposalHash, randomId } from './crypto.js';
import { fix, YeaError } from './errors.js';
import { frameId, replyFrame } from './frames.js';
import { usedOf } from './grants.js';
import type {
  AskDef,
  CommitCtx,
  IntentDef,
  Plan,
  ServiceOptions,
} from './plan.js';
import { checkProof } from './proof.js';
import { resolveRisk } from './risk.js';
import { ledgerId } from './store.js';
import type {
  Brief,
  CapabilityInfo,
  Effect,
  ErrorReply,
  Event,
  FinalReply,
  Intent,
  Proposal,
  Receipt,
  ReceiptReply,
  Request,
} from './types.js';
import { exact, isUses, type Uses } from './uses.js';
import { unixNow } from './util.js';
import { closest, validateParams } from './validate.js';

/** `requester`: the holder key whose verified proof asked for this proposal; only it may commit it. */
interface StoredProposal {
  proposal: Proposal;
  plan: Plan;
  principal: string | null;
  requester: string | null;
  created: number;
}
interface StoredReceipt {
  receipt: Receipt;
  plan: Plan;
  result: unknown;
  principal: string;
  undone?: Promise<ReceiptReply | ErrorReply>;
}

const DAY = 86400;

interface IntentRun {
  def: IntentDef;
  req: Intent;
  budget: number;
  emit: (e: Event) => void;
  principal: string | null;
}

export class Service {
  readonly id: string;
  private asks = new Map<string, AskDef>();
  private intents = new Map<string, IntentDef>();
  private proposals = new Map<string, StoredProposal>();
  private commits = new Map<string, Promise<ReceiptReply | ErrorReply>>();
  private receipts = new Map<string, StoredReceipt>();
  /** Exact amounts committed or reserved per `total` (block id and measure). */
  private used = new Map<string, bigint>();
  private autoSeen = new Map<
    string,
    { reply: Promise<FinalReply>; exp: number }
  >();

  private handles: HandleStore;
  private now: () => number;
  private authorizer: Authorizer;

  constructor(private opts: ServiceOptions) {
    this.id = opts.id;
    this.handles = opts.handles ?? new MemoryHandleStore();
    this.now = opts.now ?? unixNow;
    this.authorizer = new Authorizer(opts, this.now, this.used);
  }

  /** Register a read-only capability. */
  ask(name: string, def: AskDef): this {
    this.asks.set(name, def);

    return this;
  }

  /** Register a capability that answers with proposals. */
  intent(name: string, def: IntentDef): this {
    this.intents.set(name, def);

    return this;
  }

  get capabilities(): CapabilityInfo[] {
    const out: CapabilityInfo[] = [];

    for (const [name, d] of this.asks) {
      out.push({
        name,
        kind: 'ask',
        summary: d.summary,
        ...(d.params ? { params: d.params } : {}),
      });
    }

    for (const [name, d] of this.intents) {
      out.push({
        name,
        kind: 'intent',
        summary: d.summary,
        ...(d.params ? { params: d.params } : {}),
        ...(d.risk ? { risk: d.risk } : {}),
      });
    }

    return out;
  }

  brief(budget = this.opts.defaultBudget ?? 2000, re = 'discover'): Brief {
    const r: Brief = replyFrame(re, 'BRIEF', {
      service: {
        id: this.opts.id,
        name: this.opts.name,
        summary: this.opts.summary,
      },
      capabilities: this.capabilities,
    });

    return fit(r, budget, this.handles);
  }

  /** Handle one request frame. EVENTs go to `emit`; the final reply is returned. */
  async handle(
    frame: unknown,
    emit: (e: Event) => void = () => {
      // no listener: EVENTs are dropped
    },
  ): Promise<FinalReply> {
    const re = frameId(frame);

    try {
      if (!isRequestFrame(frame)) {
        throw new YeaError(
          'bad_frame',
          'frames need "yea": 1 and a string "id"',
        );
      }

      const req = frame;
      const budget = positiveInt(req.budget) ?? this.opts.defaultBudget ?? 2000;

      switch (req.verb) {
        case 'HELLO':
          return this.brief(budget, re);
        case 'ASK':
          return await this.onAsk(req, budget);
        case 'INTENT':
          return await this.onIntent(req, budget, emit);
        case 'COMMIT':
          return await this.onCommit(req, budget, emit);
        case 'UNDO':
          return await this.onUndo(req, budget, emit);
        case 'EXPAND':
          return await this.onExpand(req, budget);
        default:
          throw unknownVerb(req);
      }
    } catch (e) {
      return this.errorReply(re, e);
    }
  }

  private errorReply(re: string, e: unknown): ErrorReply {
    if (e instanceof YeaError) {
      return replyFrame(re, 'ERROR', {
        code: e.code,
        message: e.message,
        ...e.extra,
      });
    }

    this.opts.onError?.(e);

    return replyFrame(re, 'ERROR', {
      code: 'internal',
      message: 'the service failed unexpectedly',
      retry: 5,
    });
  }

  private unknownCapability(name: unknown, kind: 'ask' | 'intent'): never {
    const all = [...this.asks.keys(), ...this.intents.keys()];
    const other =
      kind === 'ask'
        ? this.intents.has(String(name))
        : this.asks.has(String(name));

    if (other) {
      const verb = kind === 'ask' ? 'INTENT' : 'ASK';

      throw new YeaError(
        'unknown_capability',
        `${name} is ${kind === 'ask' ? 'an intent' : 'an ask'} capability`,
        { fix: [fix(`send it with ${verb}`)] },
      );
    }

    const near = closest(String(name), all);

    throw new YeaError(
      'unknown_capability',
      `no capability named ${JSON.stringify(name)}`,
      {
        fix: near
          ? [fix(`did you mean ${near}?`)]
          : [fix(`send HELLO to list capabilities (${all.length} available)`)],
      },
    );
  }

  private async onAsk(
    req: Request & { verb: 'ASK' },
    budget: number,
  ): Promise<FinalReply> {
    const def =
      this.asks.get(req.capability) ??
      this.unknownCapability(req.capability, 'ask');
    const params = req.params ?? {};

    validateParams(def.params, params);

    const auth = await this.authorizer.authorize(req, {
      verb: 'ASK',
      capability: req.capability,
      target: req.capability,
    });
    const data = await def.run({ params, principal: auth?.iss ?? null });

    return fit(
      replyFrame(req.id, 'ANSWER', { data: data ?? null }),
      budget,
      this.handles,
      verifiedKey(req),
    );
  }

  private async onIntent(
    req: Intent,
    budget: number,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const def =
      this.intents.get(req.capability) ??
      this.unknownCapability(req.capability, 'intent');

    validateParams(def.params, req.params ?? {});

    const auth = await this.authorizer.authorize(req, {
      verb: 'INTENT',
      capability: req.capability,
      target: req.auto ? autoTarget(req) : req.capability,
    });
    const principal = auth?.iss ?? null;
    // A replayed auto INTENT (same holder key + request id) gets the original reply, never a second commit.
    const auto = autoReplayKey(req);

    if (auto) {
      const prior = this.autoSeen.get(auto.key);

      if (prior && prior.exp > this.now()) {
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
    this.autoSeen.set(key, { reply, exp: Math.max(this.now(), proofTs) + 900 });

    if (this.autoSeen.size > 10_000) {
      for (const [k, v] of this.autoSeen) {
        if (v.exp <= this.now()) {
          this.autoSeen.delete(k);
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

    const now = this.now();
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

      this.proposals.set(proposal.id, s);
      stored.push(s);
    }

    this.sweep(now);

    const committed = req.auto ? await this.autoCommit(stored[0], run) : null;

    if (committed) {
      return committed;
    }

    return fit(
      replyFrame(req.id, 'PROPOSALS', {
        proposals: stored.map((s) => s.proposal),
      }),
      budget,
      this.handles,
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
          (now + (plan.expiresIn ?? this.opts.proposalTtl ?? 600)) / 60,
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
    const ok = await this.authorizer.autoAuth(run.req, stored.proposal);

    if (!ok || (stored.principal && stored.principal !== ok.iss)) {
      return null;
    }

    const out = await this.execute(stored, ok, run.req.id, run.emit);

    return out.kind === 'RECEIPT'
      ? fit(
          { ...out, auto: true },
          run.budget,
          this.handles,
          verifiedKey(run.req),
        )
      : out;
  }

  private sweeps = 0;
  /** Bound memory: forget expired uncommitted proposals, and receipts a day after their undo window. */
  private sweep(now: number) {
    if (++this.sweeps % 100 !== 0 && this.proposals.size < 5000) {
      return;
    }

    for (const [id, s] of this.proposals) {
      if (s.proposal.expires < now - 3600 && !this.commits.has(id)) {
        this.proposals.delete(id);
      }
    }

    for (const [id, r] of this.receipts) {
      if ((r.receipt.undo?.until ?? r.receipt.at) + DAY < now) {
        this.receipts.delete(id);
        this.commits.delete(r.receipt.proposal);
        this.proposals.delete(r.receipt.proposal);
      }
    }

    for (const [k, v] of this.autoSeen) {
      if (v.exp <= now) {
        this.autoSeen.delete(k);
      }
    }
  }

  private async onCommit(
    req: Request & { verb: 'COMMIT' },
    budget: number,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const stored = this.proposals.get(req.proposal);

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
    const existing = this.commits.get(proposal.id);

    if (existing !== undefined) {
      // Idempotent replay (SPEC §4.4): same principal and requester only; limits already spent don't block it.
      const auth = await this.authorizer.authorizeRequired(req, {
        ...scope,
        replay: true,
      });

      this.checkRequester(stored, auth);

      const prior = await existing;

      if (
        prior.kind === 'RECEIPT' &&
        this.receipts.get(prior.receipt.id)?.principal !== auth.iss
      ) {
        throw new YeaError(
          'forbidden',
          'this proposal was committed by a different principal',
        );
      }

      return replayOf(prior, req.id);
    }

    const auth = await this.authorizer
      .authorizeRequired(req, scope)
      .catch((e) => {
        if (this.commits.has(proposal.id)) {
          return null; // it was committed while we waited; answer as a replay below
        }

        throw e;
      });

    // Another COMMIT of this proposal may have started while this one was being authorized.
    if (!auth || this.commits.has(proposal.id)) {
      return this.onCommit(req, budget, emit);
    }

    this.checkRequester(stored, auth);

    if (this.now() >= proposal.expires) {
      throw new YeaError('expired', 'this proposal has expired', {
        fix: [fix('send INTENT again to get a fresh proposal')],
      });
    }

    const out = await this.execute(stored, auth, req.id, emit);

    return out.kind === 'RECEIPT'
      ? fit(out, budget, this.handles, auth.holder)
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

  private execute(
    stored: StoredProposal,
    auth: Authorized,
    reqId: string,
    emit: (e: Event) => void,
  ): Promise<ReceiptReply | ErrorReply> {
    const { proposal } = stored;
    // Reserve totals synchronously, before any await, so concurrent commits can't overshoot a limit.
    const over = auth.totals.find((t) => {
      const q = usedOf(proposal.uses, t.of);
      const used = this.used.get(ledgerId({ block: t.id, of: t.of })) ?? 0n;

      return q && used + exact(q) > t.max;
    });

    if (over) {
      return Promise.resolve(
        this.errorReply(
          reqId,
          new YeaError(
            'consent_required',
            `${over.of} would pass a total limit (other commits are in flight); your principal must approve this exact proposal`,
            { consent: consentRequest(proposal, this.id, auth.iss) },
          ),
        ),
      );
    }

    this.reserve(auth, proposal, 1n);

    const run = this.apply(stored, auth, reqId, emit);

    this.commits.set(proposal.id, run);

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
        this.used.set(key, (this.used.get(key) ?? 0n) + sign * exact(q));
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
      const receipt = receiptFor(proposal, result, this.now());

      this.receipts.set(receipt.id, {
        receipt,
        plan,
        result,
        principal: auth.iss,
      });

      return replyFrame(reqId, 'RECEIPT', { receipt });
    } catch (e) {
      this.commits.delete(proposal.id); // failed commits may be retried
      this.reserve(auth, proposal, -1n);

      return this.errorReply(reqId, e);
    }
  }

  private async onUndo(
    req: Request & { verb: 'UNDO' },
    budget: number,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const stored = this.receipts.get(req.receipt);

    if (!stored || stored.receipt.undoes) {
      throw new YeaError(
        'not_found',
        `no undoable receipt ${JSON.stringify(req.receipt)}`,
      );
    }

    const auth = await this.authorizer.authorizeRequired(req, {
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

    if (this.now() > receipt.undo.until) {
      throw new YeaError(
        'expired',
        `the undo window closed at ${new Date(receipt.undo.until * 1000).toISOString()}`,
      );
    }

    stored.undone = this.revert(stored, auth, req.id, emit);

    const out = await stored.undone;

    return out.kind === 'RECEIPT'
      ? fit(out, budget, this.handles, auth.holder)
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
        at: this.now(),
        effects: receipt.effects.map(invertEffect),
        undo: null,
        undoes: receipt.id,
      };

      return replyFrame(reqId, 'RECEIPT', { receipt: undo });
    } catch (e) {
      stored.undone = undefined;

      return this.errorReply(reqId, e);
    }
  }

  private async onExpand(
    req: Request & { verb: 'EXPAND' },
    budget: number,
  ): Promise<FinalReply> {
    const parked = this.handles.get(req.handle);

    if (!parked) {
      throw new YeaError(
        'expired',
        `handle ${JSON.stringify(req.handle)} is unknown or expired`,
        { fix: [fix('repeat the original request')] },
      );
    }

    // Handles from authenticated replies expand only for the same holder key (SPEC §4.6).
    if (parked.owner) {
      const err = await checkProof(
        req.proof,
        { aud: this.id, verb: 'EXPAND', target: req.handle },
        this.now(),
      );

      if (err || req.proof?.key !== parked.owner) {
        throw new YeaError(
          'unauthorized',
          'this handle belongs to another agent',
          {
            fix: [
              fix('expand it with the same key that made the original request'),
            ],
          },
        );
      }
    } else if (this.opts.requireGrants) {
      throw new YeaError(
        'unauthorized',
        'EXPAND needs a grant from your principal',
      );
    }

    const data =
      parked.kind === 'array' ? { items: parked.items } : { text: parked.text };

    return fit(
      replyFrame(req.id, 'ANSWER', { data }),
      budget,
      this.handles,
      parked.owner ?? null,
    );
  }
}

export const service = (opts: ServiceOptions) => new Service(opts);

/** The holder key of a request whose proof has already been verified by authorize() (grants present ⇒ proof checked). */
const verifiedKey = (req: Request): string | null =>
  req.grants?.length && req.proof ? req.proof.key : null;

/** The envelope every request needs; verb-specific fields are checked where they are used. */
function isRequestFrame(frame: unknown): frame is Request {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    'yea' in frame &&
    frame.yea === 1 &&
    'id' in frame &&
    typeof frame.id === 'string'
  );
}

const positiveInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

const unknownVerb = (req: { verb?: unknown }) =>
  new YeaError('bad_frame', `unknown verb ${JSON.stringify(req.verb)}`, {
    fix: [fix('use one of HELLO, ASK, INTENT, COMMIT, UNDO, EXPAND')],
  });

/** Replay key for an auto INTENT: the holder key (proof verified by authorize()) plus the request id. */
function autoReplayKey(req: Intent): { key: string; proofTs: number } | null {
  if (!req.auto || !req.grants?.length || !req.proof) {
    return null;
  }

  return { key: `${req.proof.key}:${req.id}`, proofTs: req.proof.ts };
}

/** A prior commit/undo outcome re-issued for a repeated request. */
const replayOf = (
  prior: ReceiptReply | ErrorReply,
  re: string,
): ReceiptReply | ErrorReply =>
  prior.kind === 'RECEIPT'
    ? { ...prior, id: randomId('s', 6), re, replay: true }
    : { ...prior, id: randomId('s', 6), re };

const eventFrame = (
  re: string,
  message: string,
  progress?: number,
  data?: unknown,
): Event =>
  replyFrame(re, 'EVENT', {
    message,
    ...(progress !== undefined ? { progress } : {}),
    ...(data !== undefined ? { data } : {}),
  });

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
    ...(result !== undefined ? { result } : {}),
  };
}

const INVERSE_OP: Record<Effect['op'], Effect['op']> = {
  create: 'delete',
  delete: 'create',
  update: 'update',
  send: 'other',
  other: 'other',
};

/** The effect an undo receipt reports for reversing `e`. */
function invertEffect(e: Effect): Effect {
  switch (e.op) {
    case 'update':
      return { ...e, from: e.to, to: e.from };
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
