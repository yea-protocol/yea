/**
 * Build a YEA service. Transport-independent: `handle(frame)` turns a request frame
 * into its final reply (emitting EVENTs along the way). Transports live in node.ts / http.ts.
 * The verb handlers live in service/; this file registers capabilities and dispatches frames.
 * A verb that needs collaborators or private helpers is a `<Verb>Handler` class holding a
 * `Pick<ServiceState>`; a stateless verb is `on<Verb>(state, req, budget)`.
 */
import { Authorizer } from './authorize.js';
import { fit, MemoryHandleStore } from './budget.js';
import { fix, YeaError } from './errors.js';
import { frameId, replyFrame } from './frames.js';
import type { AskDef, IntentDef, ServiceOptions } from './plan.js';
import { onAsk } from './service/ask.js';
import { listCapabilities } from './service/capabilities.js';
import { CommitHandler } from './service/commit.js';
import { Executor } from './service/execute.js';
import { onExpand } from './service/expand.js';
import { IntentHandler } from './service/intent.js';
import { errorReply } from './service/replies.js';
import type { ServiceState } from './service/state.js';
import { Sweeper } from './service/sweep.js';
import { UndoHandler } from './service/undo.js';
import type {
  Brief,
  CapabilityInfo,
  Event,
  FinalReply,
  Request,
} from './types.js';
import { unixNow } from './util.js';

export class Service {
  readonly id: string;
  private readonly state: ServiceState;
  private readonly intentHandler: IntentHandler;
  private readonly commitHandler: CommitHandler;
  private readonly undoHandler: UndoHandler;

  constructor(opts: ServiceOptions) {
    this.id = opts.id;

    const now = opts.now ?? unixNow;
    const used = new Map<string, bigint>();

    this.state = {
      id: opts.id,
      opts,
      asks: new Map(),
      intents: new Map(),
      proposals: new Map(),
      commits: new Map(),
      receipts: new Map(),
      used,
      autoSeen: new Map(),
      handles: opts.handles ?? new MemoryHandleStore(),
      now,
      authorizer: new Authorizer(opts, now, used),
    };

    const executor = new Executor(this.state);

    this.intentHandler = new IntentHandler(
      this.state,
      executor,
      new Sweeper(this.state),
    );
    this.commitHandler = new CommitHandler(this.state, executor);
    this.undoHandler = new UndoHandler(this.state);
  }

  /** Register a read-only capability. */
  ask(name: string, def: AskDef): this {
    this.state.asks.set(name, def);

    return this;
  }

  /** Register a capability that answers with proposals. */
  intent(name: string, def: IntentDef): this {
    this.state.intents.set(name, def);

    return this;
  }

  get capabilities(): CapabilityInfo[] {
    return listCapabilities(this.state);
  }

  brief(
    budget = this.state.opts.defaultBudget ?? 2000,
    re = 'discover',
  ): Brief {
    const r: Brief = replyFrame(re, 'BRIEF', {
      service: {
        id: this.state.opts.id,
        name: this.state.opts.name,
        summary: this.state.opts.summary,
      },
      capabilities: this.capabilities,
    });

    return fit(r, budget, this.state.handles);
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
      const budget =
        positiveInt(req.budget) ?? this.state.opts.defaultBudget ?? 2000;

      switch (req.verb) {
        case 'HELLO':
          return this.brief(budget, re);
        case 'ASK':
          return await onAsk(this.state, req, budget);
        case 'INTENT':
          return await this.intentHandler.onIntent(req, budget, emit);
        case 'COMMIT':
          return await this.commitHandler.onCommit(req, budget, emit);
        case 'UNDO':
          return await this.undoHandler.onUndo(req, budget, emit);
        case 'EXPAND':
          return await onExpand(this.state, req, budget);
        default:
          throw unknownVerb(req);
      }
    } catch (e) {
      return errorReply(this.state.opts, re, e);
    }
  }
}

export const service = (opts: ServiceOptions) => new Service(opts);

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
