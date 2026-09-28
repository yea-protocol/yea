/**
 * Test harness: a fake Stripe, a clock the tests move, the jobs' context, and for MCP tests a
 * temp YEA home and store, a pinned principal, the README's suggested grant, and in-memory
 * clients of the kinds @yea-protocol/mcp's tests use.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Client,
  type ElicitResult,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  type CallToolResult,
  createMcpHandler,
  InMemoryTransport,
  type McpServer,
} from '@modelcontextprotocol/server';
import { type Approvals, yea } from '@yea-protocol/mcp';
import {
  hashPlans,
  issueGrant,
  type JobPlan,
  type KeyPair,
  keyPair,
  readJobConsent,
  signJobConsent,
} from '@yea-protocol/sdk';
import { FileStore } from '@yea-protocol/sdk/node';
import type { Ctx, JobSpec } from '../src/context.js';
import { contextFor, stripeServer } from '../src/server.js';
import { D, type FakeState, fakeStripe } from './fake-stripe.js';

/** Sunday 2026-09-27, 10:00 UTC. */
export const NOW = Date.UTC(2026, 8, 27, 10) / 1000;

export const TEST_KEY = 'sk_test_51abcDEF';
export const LIVE_KEY = 'sk_live_51abcDEF';

export { D };

export interface Setup {
  stripe: ReturnType<typeof fakeStripe>;
  ctx: Ctx;
  clock: { now: number };
}

/** A fake Stripe and the jobs' context over it, at `NOW`. */
export function setup(
  o: {
    live?: boolean;
    declines?: boolean;
    state?: (s: FakeState) => Partial<FakeState>;
  } = {},
): Setup {
  const stripe = fakeStripe({
    now: NOW,
    declines: o.declines ?? false,
    ...(o.state ? { state: o.state } : {}),
  });
  const clock = { now: NOW };
  const ctx = contextFor({
    key: o.live ? LIVE_KEY : TEST_KEY,
    fetch: stripe.fetch,
    now: () => clock.now,
    sleep: async () => {},
  });

  return { stripe, ctx, clock };
}

/** A job's plans, or throw if it asked a question instead. */
export async function plansOf<I>(
  spec: JobSpec<I>,
  input: I,
): Promise<JobPlan[]> {
  const out = await spec.plan(input);

  if (!Array.isArray(out)) {
    throw new Error(`expected plans, got ${JSON.stringify(out)}`);
  }

  return out;
}

/** The plan hashes the approval core would compute. */
export async function hashesOf<I>(spec: JobSpec<I>, input: I) {
  const plans = await plansOf(spec, input);
  const hashed = await hashPlans(
    { name: spec.name, risk: spec.risk, revert: spec.revert },
    input,
    plans,
  );

  return hashed.map((h) => h.planHash);
}

export const tmp = () => mkdtempSync(join(tmpdir(), 'yea-stripe-'));

export const nowS = () => Math.floor(Date.now() / 1000);

export interface World extends Setup {
  home: string;
  store: FileStore;
  principal: KeyPair;
  approvals: Approvals;
  factory: () => McpServer;
}

/** A temp YEA home and store, a pinned principal, and the server over a fake Stripe. */
export async function world(
  o: { live?: boolean; state?: (s: FakeState) => Partial<FakeState> } = {},
): Promise<World> {
  const home = tmp();

  process.env.YEA_HOME = home;
  delete process.env.YEA_POLICY;
  delete process.env.YEA_STORE;
  delete process.env.YEA_PRINCIPAL_PUB;

  const principal = await keyPair();
  const store = new FileStore(join(home, 'store'));
  const approvals = yea({
    name: 'yea-stripe',
    transport: 'stdio',
    store,
    principal: principal.public,
  });
  const s = setup(o);
  const factory = stripeServer({
    key: o.live ? LIVE_KEY : TEST_KEY,
    approvals,
    fetch: s.stripe.fetch,
    now: () => s.clock.now,
    sleep: async () => {},
  });

  return { ...s, home, store, principal, approvals, factory };
}

/**
 * The README's suggested grant:
 * `yea grant --to <server key> --can cancel_subscription --can change_plan --risk low --exp 30d`.
 */
export async function suggestedGrant(
  w: World,
  caveats: Record<string, unknown>[] = [
    { can: ['cancel_subscription', 'change_plan'] },
    { risk: 'low' },
  ],
) {
  const token = await issueGrant({
    principal: w.principal,
    to: await w.approvals.serviceId(),
    caveats: [...caveats, { exp: nowS() + 30 * D }] as never,
  });
  const path = join(w.home, 'policy.pg');

  writeFileSync(path, `${token}\n`);
  process.env.YEA_POLICY = path;

  return token;
}

export type Kind = '2026' | '2025' | '2026-no-elicit' | '2025-no-elicit';

export type Answer =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline' | 'cancel' };

export type AnswerStep = Answer | (() => Promise<Answer>);

export interface Conn {
  client: Client;
  elicited: { message: string; requestedSchema: Record<string, unknown> }[];
  answers: AnswerStep[];
  call(tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/** Connect a client of `kind`: 2026 over Streamable HTTP, 2025 over an in-memory link. */
export async function connect(
  kind: Kind,
  factory: () => McpServer,
): Promise<Conn> {
  const elicit = !kind.endsWith('no-elicit');
  const conn = { elicited: [], answers: [] as AnswerStep[] } as Pick<
    Conn,
    'elicited' | 'answers'
  >;
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    {
      capabilities: elicit ? { elicitation: { form: {} } } : {},
      ...(kind.startsWith('2026')
        ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
        : {}),
    },
  );

  if (elicit) {
    client.setRequestHandler('elicitation/create', async (req) => {
      const p = req.params as Conn['elicited'][number];

      conn.elicited.push({
        message: p.message,
        requestedSchema: p.requestedSchema,
      });

      const next = conn.answers.shift() ?? { action: 'cancel' };

      return (typeof next === 'function' ? await next() : next) as ElicitResult;
    });
  }

  if (kind.startsWith('2025')) {
    const [ct, st] = InMemoryTransport.createLinkedPair();

    await factory().connect(st);
    await client.connect(ct);
  } else {
    const handler = createMcpHandler(factory);

    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://yea.test/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
  }

  return {
    ...conn,
    client,
    call: (tool, args) =>
      client.callTool({
        name: tool,
        arguments: args,
      }) as Promise<CallToolResult>,
  };
}

/** The text of a result. */
export const textOf = (r: { content?: unknown }) =>
  ((r.content ?? []) as { type: string; text?: string }[])
    .map((c) => c.text ?? '')
    .join('\n');

/** What `yea approve <code>` does, without the terminal. */
export async function approve(w: World, code: string) {
  const j = await readJobConsent(code, nowS());

  await w.store.putConsent(j.planHash, await signJobConsent(w.principal, j));

  return j;
}

/** Accept the form with this phrase, choosing the plan whose title starts with `plan`. */
export const accept =
  (conn: Conn, confirm: string, plan?: string): (() => Promise<Answer>) =>
  async () => {
    const schema = conn.elicited.at(-1)?.requestedSchema as {
      properties: { plan?: { oneOf: { const: string; title: string }[] } };
    };
    const choice = plan
      ? schema.properties.plan?.oneOf.find((x) => x.title.includes(plan))?.const
      : undefined;

    return {
      action: 'accept',
      content: { confirm, ...(choice ? { plan: choice } : {}) },
    };
  };
