/**
 * Build a YEA service. Transport-independent: `handle(frame)` turns a request frame
 * into its final reply (emitting EVENTs along the way). Transports live in node.ts / http.ts.
 * The verb handlers live in service/; this file registers capabilities and dispatches frames.
 * A verb that needs private helpers is a `<Verb>Handler` class holding a `Pick<ServiceState>`;
 * the rest are `on<Verb>(state, req)`. Each proposal's life is the commit ledger's.
 */
import { fit, MemoryHandleStore } from './budget.js';
import { frameId, replyFrame } from './frames.js';
import type { AskDef, IntentDef, ServiceOptions } from './plan.js';
import { onAsk } from './service/ask.js';
import { listCapabilities } from './service/capabilities.js';
import { onCommit } from './service/commit.js';
import { CommitLedger } from './service/commit-ledger.js';
import { onExpand } from './service/expand.js';
import { IntentHandler } from './service/intent.js';
import { errorReply } from './service/replies.js';
import type { ServiceState } from './service/state.js';
import { onUndo } from './service/undo.js';
import { verifyRequest } from './service/verified-request.js';
import type { Brief, CapabilityInfo, Event, FinalReply } from './types.js';
import { unixNow } from './util.js';

export class Service {
  readonly id: string;
  private readonly state: ServiceState;
  private readonly intentHandler: IntentHandler;

  constructor(opts: ServiceOptions) {
    this.id = opts.id;

    const now = opts.now ?? unixNow;

    this.state = {
      id: opts.id,
      opts,
      asks: new Map(),
      intents: new Map(),
      ledger: new CommitLedger({ id: opts.id, opts, now }),
      handles: opts.handles ?? new MemoryHandleStore(),
      now,
    };
    this.intentHandler = new IntentHandler(this.state);
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

  /**
   * Handle one request frame: verify it, then run its verb's handler. EVENTs go to `emit`; the
   * final reply is returned. An `emit` that throws (an EVENT a transport can't serialize) never
   * fails the request: see `neverThrows`.
   */
  async handle(
    frame: unknown,
    emit: (e: Event) => void = () => {
      // no listener: EVENTs are dropped
    },
  ): Promise<FinalReply> {
    const re = frameId(frame);
    const send = neverThrows(emit, this.state.opts.onError);

    try {
      const req = await verifyRequest(this.state, frame);

      switch (req.verb) {
        case 'HELLO':
          return this.brief(req.budget, re);
        case 'ASK':
          return await onAsk(this.state, req);
        case 'INTENT':
          return await this.intentHandler.onIntent(req, send);
        case 'COMMIT':
          return await onCommit(this.state, req, send);
        case 'UNDO':
          return await onUndo(this.state, req, send);
        case 'EXPAND':
          return onExpand(this.state, req);
      }
    } catch (e) {
      return errorReply(this.state.opts, re, e);
    }
  }
}

export const service = (opts: ServiceOptions) => new Service(opts);

/**
 * `emit`, but an EVENT it throws on is dropped and reported to `onError`. A throw would otherwise
 * fail a commit mid-`apply`, release it, and let a retry run `apply` a second time.
 */
function neverThrows(
  emit: (e: Event) => void,
  onError: ServiceOptions['onError'],
): (e: Event) => void {
  return (e) => {
    try {
      emit(e);
    } catch (err) {
      try {
        onError?.(
          new Error(`dropped an EVENT that could not be sent (re ${e.re})`, {
            cause: err,
          }),
        );
      } catch {
        // a failing onError must not fail the request either
      }
    }
  };
}
