/**
 * The MCP-client side of the tests, shared by @yea-protocol/mcp and the connectors: temp YEA
 * homes, installing a signed policy grant, the in-memory clients that answer elicitation forms,
 * and what `yea approve <code>` does without the terminal (SPEC-mcp-ts, Testing).
 *
 * Nothing here imports a package's source, so a connector can import this file by relative path.
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
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  type Caveat,
  issueGrant,
  type KeyPair,
  keyPair,
  readJobConsent,
  signJobConsent,
  unixNow,
} from '@yea-protocol/sdk';
import { FileStore } from '@yea-protocol/sdk/node';

/** A fresh temp directory. */
export const tmp = (prefix = 'yea-mcp-') => mkdtempSync(join(tmpdir(), prefix));

export interface Home {
  home: string;
  store: FileStore;
  storeDir: string;
  principal: KeyPair;
}

/** A fresh YEA home with a store in it and a principal; the other YEA_* variables are unset. */
export async function freshHome(prefix?: string): Promise<Home> {
  const home = tmp(prefix);
  const storeDir = join(home, 'store');

  process.env.YEA_HOME = home;
  delete process.env.YEA_POLICY;
  delete process.env.YEA_STORE;
  delete process.env.YEA_PRINCIPAL_PUB;
  delete process.env.YEA_PRINCIPAL_HOME;

  return {
    home,
    store: new FileStore(storeDir),
    storeDir,
    principal: await keyPair(),
  };
}

/** Whoever a policy grant goes to: a home, its principal, and the server's key. */
export interface Grantee {
  home: string;
  principal: KeyPair;
  approvals: { serviceId(): Promise<string> };
}

/**
 * Issue a signed policy grant to the server, valid for `ttl` seconds, and install it (what
 * `yea grant` makes). YEA_POLICY names a file, read on every call: a new grant applies without
 * a restart.
 */
export async function installGrant(
  w: Grantee,
  caveats: Caveat[],
  ttl: number,
): Promise<string> {
  const token = await issueGrant({
    principal: w.principal,
    to: await w.approvals.serviceId(),
    caveats: [...caveats, { exp: unixNow() + ttl }],
  });
  const path = join(w.home, 'policy.pg');

  writeFileSync(path, `${token}\n`);
  process.env.YEA_POLICY = path;

  return token;
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
  call(args: Record<string, unknown>, tool: string): Promise<CallToolResult>;
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
    call: (args, tool) =>
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

/** Accept the open form with this phrase, choosing the plan whose title includes `plan`. */
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

/** The text of a result. */
export const textOf = (r: { content?: unknown }) =>
  ((r.content ?? []) as { type: string; text?: string }[])
    .map((c) => c.text ?? '')
    .join('\n');

/** What `yea approve <code>` does, without the terminal: check the code, sign, and store. */
export async function approve(
  w: { store: FileStore; principal: KeyPair },
  code: string,
) {
  const j = await readJobConsent(code, unixNow());

  await w.store.putConsent(j.planHash, await signJobConsent(w.principal, j));

  return j;
}
