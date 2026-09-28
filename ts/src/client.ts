/** YEA client: what an agent (or its harness) uses to talk to a service. */
import { randomId } from './crypto.js';
import { type Caveat, decodeGrant, makeProof } from './grants.js';
import { lens } from './lens.js';
import { isRisk } from './risk.js';
import type { Service } from './service.js';
import type {
  Answer,
  Brief,
  Clarify,
  ErrorReply,
  Event,
  FinalReply,
  Proposal,
  Proposals,
  Receipt,
  ReceiptReply,
  Reply,
  Request,
  Verb,
} from './types.js';
import { isUses } from './uses.js';

const MAX_REPLY = 16 << 20;

export interface Transport {
  request(frame: Request, onEvent?: (e: Event) => void): Promise<FinalReply>;
  close(): void;
}

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

const hasSvc = (c: Caveat): c is { svc: string[] } =>
  Boolean((c as { svc?: unknown }).svc);

/** Whether a grant may be sent to `aud`: its `svc` caveat, if any, lists it. Undecodable grants may not. */
function grantCovers(token: string, aud: string): boolean {
  try {
    const scope = decodeGrant(token)
      .flatMap((b) => b.p.caveats)
      .find(hasSvc);

    return !scope || scope.svc.includes(aud);
  } catch {
    return false;
  }
}

/** What is malformed about a proposal or receipt (SPEC §5.1), or null if nothing is. */
function malformedPart(x: Proposal | Receipt, isProposal: boolean) {
  if (x.uses !== undefined && !isUses(x.uses)) {
    return 'a malformed uses';
  }

  // Only a proposal carries a risk.
  return isProposal && !isRisk((x as Proposal).risk) ? 'an unknown risk' : null;
}

/**
 * SPEC §5.1: a proposal with a malformed `uses` or an unknown `risk`, or a receipt with a
 * malformed `uses`, is invalid, so the reply becomes a local `bad_frame` error instead of
 * something a model or a person might act on.
 */
function rejectMalformed(reply: FinalReply): FinalReply {
  const isProposal = reply.kind === 'PROPOSALS';
  const items: (Proposal | Receipt)[] = isProposal
    ? reply.proposals
    : reply.kind === 'RECEIPT'
      ? [reply.receipt]
      : [];

  for (const x of items) {
    const why = malformedPart(x, isProposal);

    if (why) {
      return {
        yea: 1,
        id: reply.id,
        re: reply.re,
        kind: 'ERROR',
        code: 'bad_frame',
        message: `${isProposal ? 'proposal' : 'receipt'} ${x.id} from the service has ${why}, so it was ignored`,
      };
    }
  }

  return reply;
}

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
    const target = o.auto ? `auto:${capability}:${id}` : capability;

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

/** In-process transport: call a Service directly (tests, embedding, MCP bridge). */
export function local(svc: Service): Transport {
  return {
    request: (frame, onEvent) =>
      svc.handle(JSON.parse(JSON.stringify(frame)), onEvent),
    close() {
      // nothing to release: the service runs in this process
    },
  };
}

/** Split off the complete lines in `buf`: the trimmed non-empty ones, and the unterminated rest. */
function completeLines(buf: string): { complete: string[]; rest: string } {
  const end = buf.lastIndexOf('\n') + 1;

  return {
    complete: buf
      .slice(0, end)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    rest: buf.slice(end),
  };
}

/** Pass EVENT lines to `onEvent` until the final reply, which is returned (undefined if none yet). */
function firstFinal(
  lines: string[],
  onEvent?: (e: Event) => void,
): FinalReply | undefined {
  for (const line of lines) {
    const f = JSON.parse(line) as Reply;

    if (f.kind === 'EVENT') {
      onEvent?.(f);
    } else {
      return f;
    }
  }

  return undefined;
}

/** Read an NDJSON reply stream up to its final reply. */
async function readFinal(
  body: NonNullable<Response['body']>,
  onEvent?: (e: Event) => void,
): Promise<FinalReply> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';

  for (;;) {
    const { value, done } = await reader.read();

    if (value) {
      buf += value;
    }

    if (buf.length > MAX_REPLY) {
      throw new Error('reply exceeds 16 MiB without a newline');
    }

    const { complete, rest } = completeLines(buf);

    buf = rest;

    const final = firstFinal(complete, onEvent);

    if (final) {
      return final;
    }

    if (done) {
      break;
    }
  }

  if (buf.trim()) {
    return JSON.parse(buf);
  }

  throw new Error('HTTP bridge closed without a final reply');
}

/** HTTP bridge transport (SPEC §2.4). Works anywhere `fetch` exists. */
export function http(
  endpoint: string,
  init: { headers?: Record<string, string> } = {},
): Transport {
  return {
    async request(frame, onEvent) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...init.headers },
        body: JSON.stringify(frame),
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} from ${endpoint}`);
      }

      return readFinal(res.body, onEvent);
    },
    close() {
      // each request is its own fetch; there is no connection to close
    },
  };
}

/** Line-framed stream transport over any duplex (TCP, TLS, child stdio). */
export function lines(
  write: (line: string) => void,
  close: () => void,
): Transport & { feed(chunk: string): void; fail(err: Error): void } {
  const pending = new Map<
    string,
    {
      resolve: (r: FinalReply) => void;
      reject: (e: Error) => void;
      onEvent?: (e: Event) => void;
    }
  >();
  let buf = '';
  /** Route one reply line to the request it answers; unparseable or unmatched lines are dropped. */
  const deliver = (line: string) => {
    let f: Reply;

    try {
      f = JSON.parse(line);
    } catch {
      return;
    }

    const p = pending.get(f.re);

    if (!p) {
      return;
    }

    if (f.kind === 'EVENT') {
      p.onEvent?.(f);
    } else {
      pending.delete(f.re);
      p.resolve(f);
    }
  };

  return {
    request(frame, onEvent) {
      return new Promise((resolve, reject) => {
        pending.set(frame.id, { resolve, reject, onEvent });
        write(`${JSON.stringify(frame)}\n`);
      });
    },
    feed(chunk) {
      buf += chunk;

      if (buf.length > MAX_REPLY && buf.indexOf('\n') < 0) {
        buf = '';
        this.fail(new Error('reply exceeds 16 MiB without a newline'));
        close();

        return;
      }

      const { complete, rest } = completeLines(buf);

      buf = rest;

      for (const line of complete) {
        deliver(line);
      }
    },
    fail(err) {
      for (const p of pending.values()) {
        p.reject(err);
      }

      pending.clear();
    },
    close,
  };
}
