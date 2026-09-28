/**
 * Test harness: a temp YEA home and store, a principal key pinned through the `principal`
 * option (a real pinned file can't be made in a test: the check refuses files this user owns),
 * a `refund` job, and the three kinds of in-memory client (SPEC-mcp-ts, Testing).
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
  McpServer,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  type Caveat,
  decodeGrant,
  issueGrant,
  type KeyPair,
  keyPair,
  quantity,
  readJobConsent,
  sha256,
  signJobConsent,
} from '@yea-protocol/sdk';
import { FileStore } from '@yea-protocol/sdk/node';
import * as z from 'zod';
import {
  type Approvals,
  type JobConfig,
  type YeaOptions,
  yea,
} from '../src/index.js';

export const tmp = () => mkdtempSync(join(tmpdir(), 'yea-mcp-'));

export const nowS = () => Math.floor(Date.now() / 1000);

export interface World {
  home: string;
  store: FileStore;
  storeDir: string;
  principal: KeyPair;
  policyPath: string;
  applied: string[];
  reverted: unknown[];
  approvals: Approvals;
  options: YeaOptions;
}

/** A fresh YEA home, store and principal, and `yea()` over them. */
export async function world(over: Partial<YeaOptions> = {}): Promise<World> {
  const home = tmp();
  const storeDir = join(home, 'store');

  process.env.YEA_HOME = home;
  delete process.env.YEA_POLICY;
  delete process.env.YEA_STORE;
  delete process.env.YEA_PRINCIPAL_PUB;

  const principal = await keyPair();
  const store = new FileStore(storeDir);
  const policyPath = join(home, 'policy.pg');
  const options: YeaOptions = {
    name: 'billing',
    transport: 'stdio',
    store,
    principal: principal.public,
    ...over,
  };

  return {
    home,
    store,
    storeDir,
    principal,
    policyPath,
    applied: [],
    reverted: [],
    approvals: yea(options),
    options,
  };
}

/** Issue and install a signed policy grant to the server (what `yea grant` makes). */
export async function grantPolicy(
  w: World,
  caveats: Caveat[] = [
    { can: ['refund'] },
    { risk: 'low' },
    { total: { of: 'emails', max: 2 } },
  ],
): Promise<string> {
  const token = await issueGrant({
    principal: w.principal,
    to: await w.approvals.serviceId(),
    caveats: [...caveats, { exp: nowS() + 3600 }],
  });

  // YEA_POLICY names a file, read on every call: a new grant applies without a restart.
  writeFileSync(w.policyPath, `${token}\n`);
  process.env.YEA_POLICY = w.policyPath;

  return token;
}

/** The ledger key a policy's root-block `total` uses. */
export const ledgerKeyOf = async (token: string, of = 'emails') => ({
  block: await sha256(decodeGrant(token)[0].s),
  of,
});

/** The `refund` job: one undoable, low-risk plan that sends one email. */
export function refundJob(
  w: World,
  over: Partial<JobConfig<z.ZodObject<{ charge: z.ZodString }>>> = {},
): JobConfig<z.ZodObject<{ charge: z.ZodString }>> {
  return {
    description: 'Refund what is left of a charge',
    inputSchema: z.object({ charge: z.string() }),
    risk: 'low',
    plan: ({ charge }) => [
      {
        summary: `Refund 20.00 USD of ${charge}`,
        effects: [
          { op: 'create', target: 'refund', detail: `20.00 USD of ${charge}` },
        ],
        uses: { emails: quantity(1) },
        undoWindow: 3600,
        apply: () => {
          w.applied.push(charge);

          return { refunded: charge };
        },
      },
    ],
    revert: ({ input }) => {
      w.reverted.push(input);
    },
    confirmWith: (_hp, { charge }) => charge,
    ...over,
  };
}

/** A server factory with the refund job, as an author writes it. `seen` records verified states. */
export function refundServer(
  w: World,
  over: Partial<JobConfig<z.ZodObject<{ charge: z.ZodString }>>> = {},
  o: { approvals?: Approvals; seen?: string[] } = {},
) {
  const approvals = o.approvals ?? w.approvals;
  const { verify } = approvals.serverOptions().requestState;

  return () => {
    const server = new McpServer(
      { name: 'billing', version: '1.0.0' },
      {
        requestState: {
          verify: (state, ctx) => {
            o.seen?.push(state);

            return verify(state, ctx);
          },
        },
      },
    );

    approvals.job(server, 'refund', refundJob(w, over));

    return server;
  };
}

/**
 * `2026`/`2025` elicit; the `-no-elicit` kinds and `legacy-http` (stateless 2025 HTTP) can't.
 * The `2026` kinds go through `createMcpHandler`, the `2025` kinds through `server.connect`, and
 * the `stdio-` kinds through `serveStdio` over an in-memory transport.
 */
export type Kind =
  | '2026'
  | '2025'
  | '2026-no-elicit'
  | '2025-no-elicit'
  | 'legacy-http'
  | 'stdio-2026'
  | 'stdio-2025';

export type Answer =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline' | 'cancel' };

/** An answer, or a function the client runs while the form is open. */
export type AnswerStep = Answer | (() => Promise<Answer>);

export interface Conn {
  client: Client;
  /** The elicitation requests the client was sent (message and schema). */
  elicited: { message: string; requestedSchema: Record<string, unknown> }[];
  /** Answers the person gives, in order; once they run out, the form is cancelled. */
  answers: AnswerStep[];
  call(args: Record<string, unknown>, tool?: string): Promise<CallToolResult>;
  /** A raw `tools/call`, for retries a well-behaved client wouldn't send. */
  raw(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const clientInfo = { name: 'test-client', version: '1.0.0' };

function elicitingClient(kind: Kind, conn: Pick<Conn, 'elicited' | 'answers'>) {
  const elicit = !kind.endsWith('no-elicit') && kind !== 'legacy-http';
  const client = new Client(clientInfo, {
    capabilities: elicit ? { elicitation: { form: {} } } : {},
    ...(kind.includes('2026')
      ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      : {}),
  });

  if (elicit) {
    client.setRequestHandler('elicitation/create', async (req) => {
      const p = req.params as Conn['elicited'][number];

      conn.elicited.push({
        message: p.message,
        requestedSchema: p.requestedSchema,
      });

      const next = conn.answers.shift() ?? { action: 'cancel' };

      // Tests answer with anything, including what a real form couldn't send.
      return (typeof next === 'function' ? await next() : next) as ElicitResult;
    });
  }

  return client;
}

/** Connect a client of `kind` to servers made by `factory`. */
export async function connect(
  kind: Kind,
  factory: () => McpServer,
): Promise<Conn> {
  const partial = { elicited: [], answers: [] as AnswerStep[] };
  const client = elicitingClient(kind, partial);

  if (kind.startsWith('stdio')) {
    const [ct, st] = InMemoryTransport.createLinkedPair();

    serveStdio(factory, { transport: st });
    await client.connect(ct);
  } else if (kind === '2025' || kind === '2025-no-elicit') {
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
    ...partial,
    client,
    call: (args, tool = 'refund') =>
      client.callTool({
        name: tool,
        arguments: args,
      }) as Promise<CallToolResult>,
    raw: (params) =>
      (
        client as unknown as {
          request(r: unknown, o: unknown): Promise<Record<string, unknown>>;
        }
      ).request({ method: 'tools/call', params }, { allowInputRequired: true }),
  };
}

/** The text of a result. */
export const textOf = (r: { content?: unknown }) =>
  ((r.content ?? []) as { type: string; text?: string }[])
    .map((c) => c.text ?? '')
    .join('\n');

/** What `yea approve <code>` does, without the terminal: check the code, sign, and store. */
export async function approve(w: World, code: string) {
  const j = await readJobConsent(code, nowS());

  await w.store.putConsent(j.planHash, await signJobConsent(w.principal, j));

  return j;
}
