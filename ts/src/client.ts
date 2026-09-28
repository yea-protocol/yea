/**
 * YEA client: what an agent (or its harness) uses to talk to a service.
 * The Client and its reply types live here; the transports, grant scoping and the SPEC §5.1
 * reply check live in client/.
 */
import { grantCovers } from './client/grant-scope.js';
import { rejectMalformed } from './client/reply-check.js';
import type { Transport } from './client/transport.js';
import { randomId } from './crypto.js';
import { lens } from './lens.js';
import { autoTarget, makeProof } from './proof.js';
import type {
  Answer,
  Brief,
  Clarify,
  ErrorReply,
  Event,
  FinalReply,
  Proposal,
  Proposals,
  ReceiptReply,
  Request,
  Verb,
} from './types.js';

export { http } from './client/http-transport.js';
export { lines } from './client/line-transport.js';
export { local, type Transport } from './client/transport.js';

/** Every reply the client returns carries its Lens: the text to show a model. */
export type WithLens<T> = T & { lens: string };

export type IntentResult = WithLens<
  Proposals | Clarify | ReceiptReply | ErrorReply
>;

export interface ClientOptions {
  /** The agent's Ed25519 seed (b64url). Needed to use grants. */
  key?: string;
  grants?: string[];
  name?: string;
  budget?: number;
}

type Dist<T> = T extends unknown ? Omit<T, 'yea' | 'id'> : never;

export class Client {
  private serviceId?: string;
  private grants: string[];
  constructor(
    private transport: Transport,
    private opts: ClientOptions = {},
  ) {
    this.grants = [...(opts.grants ?? [])];
  }

  /** The agent's seed, if any. */
  get key(): string | undefined {
    return this.opts.key;
  }

  addGrant(token: string) {
    this.grants.push(token);
  }

  private async send<T extends FinalReply>(
    body: Dist<Request>,
    onEvent?: (e: WithLens<Event>) => void,
  ): Promise<WithLens<T>> {
    const frame = { yea: 1, id: randomId('c', 6), ...body } as Request;
    const received = await this.transport.request(
      frame,
      onEvent && ((e) => onEvent({ ...e, lens: e.lens ?? lens(e) })),
    );
    const reply = rejectMalformed(received);

    return { ...reply, lens: reply.lens ?? lens(reply) } as WithLens<T>;
  }

  /**
   * The grants this client sends its service with each request: its own, less any whose `svc`
   * caveat names other services. None without an agent key, since a grant needs its proof.
   */
  async grantsSent(extra: string[] = []): Promise<string[]> {
    const all = [...this.grants, ...extra];

    if (!this.opts.key || !all.length) {
      return [];
    }

    const aud = await this.audience();

    return all.filter((g) => grantCovers(g, aud));
  }

  private async signed(
    verb: Verb,
    target: string,
    extra: string[] = [],
  ): Promise<Pick<Request, 'grants' | 'proof'>> {
    const grants = await this.grantsSent(extra);

    if (!this.opts.key || !grants.length) {
      return {};
    }

    const aud = await this.audience();

    return {
      grants,
      proof: await makeProof(this.opts.key, { aud, verb, target }),
    };
  }

  /** The service's audience id (learned from HELLO). */
  async audience(): Promise<string> {
    if (!this.serviceId) {
      await this.hello(200);
    }

    if (!this.serviceId) {
      throw new Error('the service did not identify itself (HELLO failed)');
    }

    return this.serviceId;
  }

  async hello(
    budget = this.opts.budget,
  ): Promise<WithLens<Brief | ErrorReply>> {
    const r = await this.send<Brief | ErrorReply>({
      verb: 'HELLO',
      agent: { name: this.opts.name },
      ...(budget ? { budget } : {}),
    });

    if (r.kind === 'BRIEF') {
      this.serviceId = r.service.id;
    }

    return r;
  }

  async ask(
    capability: string,
    params: Record<string, unknown> = {},
    o: { budget?: number } = {},
  ): Promise<WithLens<Answer | ErrorReply>> {
    const budget = o.budget ?? this.opts.budget;

    return this.send({
      verb: 'ASK',
      capability,
      params,
      ...(budget ? { budget } : {}),
      ...(await this.signed('ASK', capability)),
    });
  }

  /**
   * Express an intent. With `auto`, the service commits the first proposal in the same round
   * trip when your grants already allow it and it is undoable; you get a RECEIPT back.
   */
  async intent(
    capability: string,
    params: Record<string, unknown> = {},
    o: {
      goal?: string;
      budget?: number;
      auto?: boolean;
      onEvent?: (e: WithLens<Event>) => void;
    } = {},
  ): Promise<IntentResult> {
    const budget = o.budget ?? this.opts.budget;
    const id = randomId('c', 6);
    // auto-commit proofs are bound to this request id, so a captured frame can't be replayed into new commits
    const target = o.auto ? autoTarget(capability, id) : capability;

    return this.send(
      {
        id,
        verb: 'INTENT',
        capability,
        params,
        ...(o.goal ? { goal: o.goal } : {}),
        ...(o.auto ? { auto: true } : {}),
        ...(budget ? { budget } : {}),
        ...(await this.signed('INTENT', target)),
      } as Dist<Request>,
      o.onEvent,
    );
  }

  /** Commit a proposal. `grants` adds one-off grants (e.g. a consent grant) for this call only. */
  async commit(
    p: Pick<Proposal, 'id' | 'hash'>,
    o: {
      grants?: string[];
      onEvent?: (e: WithLens<Event>) => void;
      budget?: number;
    } = {},
  ): Promise<WithLens<ReceiptReply | ErrorReply>> {
    return this.send(
      {
        verb: 'COMMIT',
        proposal: p.id,
        hash: p.hash,
        ...(o.budget ? { budget: o.budget } : {}),
        ...(await this.signed('COMMIT', p.hash, o.grants)),
      },
      o.onEvent,
    );
  }

  async undo(
    receipt: string,
    o: { onEvent?: (e: WithLens<Event>) => void } = {},
  ): Promise<WithLens<ReceiptReply | ErrorReply>> {
    return this.send(
      { verb: 'UNDO', receipt, ...(await this.signed('UNDO', receipt)) },
      o.onEvent,
    );
  }

  async expand(
    handle: string,
    o: { budget?: number } = {},
  ): Promise<WithLens<Answer | ErrorReply>> {
    const budget = o.budget ?? this.opts.budget;

    return this.send({
      verb: 'EXPAND',
      handle,
      ...(budget ? { budget } : {}),
      ...(await this.signed('EXPAND', handle)),
    });
  }

  close() {
    this.transport.close();
  }
}
