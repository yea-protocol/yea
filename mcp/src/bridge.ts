/**
 * `@yea-protocol/mcp/bridge`: YEA services as MCP tools, one per remote capability
 * (docs/framework/SPEC-bridge.md). `yea mcp` runs it over stdio.
 *
 * The bridge has no policy of its own: each service checks the agent's grants, auto-commits
 * what they allow, and demands a consent grant for the rest (SPEC.md §4.3.1, §6.6). The bridge
 * shows the proposals, hands out consent codes for `yea approve`, relays the signed consent,
 * and commits.
 *
 * TODO(#73): `--approve-here` (typed approval in the client, signed with a principal key on this
 * machine) waits for James (decision 4). Nothing here loads a principal key or signs anything.
 */
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { Client, unixNow } from '@yea-protocol/sdk';
import { type ConsentStore, homeConsents } from './bridge/consent.js';
import { greet } from './bridge/greet.js';
import { instructionsFor } from './bridge/instructions.js';
import { passThrough } from './bridge/params.js';
import { PendingProposals } from './bridge/pending.js';
import type { Bridge } from './bridge/state.js';
import type { ToolMode } from './bridge/tools/generic.js';
import { buildTools, errorOf, utilityTools } from './bridge/tools.js';
import type { ToolSpec } from './bridge/types.js';
import type { Obj } from './util.js';

export type { ConsentStore } from './bridge/consent.js';
export type { ToolMode } from './bridge/tools/generic.js';

const VERSION = '0.1.0';

export interface BridgeOptions {
  /** `generic` or `per-capability` for every service; default: generic past 25 capabilities. */
  tools?: ToolMode;
  /** The token budget for reads, expands and proposals. Default 1500. */
  budget?: number;
  /** Where consents are kept. Default: the agent's `~/.yea/consents`. */
  consents?: ConsentStore;
  /** Unsigned tightening, merged with `~/.yea/policy.json`; only `deny` applies. */
  tighten?: { deny?: string[] };
  /** The clock, in seconds. For tests. */
  now?: () => number;
}

/** A service's client, and the URL to name it by in messages. */
export type BridgeService = Client | { client: Client; url: string };

/** A server factory for `serveStdio` or `createMcpHandler`; every server shares one bridge. */
export interface BridgeFactory {
  (): McpServer;
  instructions: string;
  /** The remote tools' names. */
  tools: string[];
}

/** Register one tool; anything it throws becomes a tool error, not a crash. */
function register(server: McpServer, t: ToolSpec) {
  server.registerTool(
    t.name,
    {
      description: t.description,
      inputSchema: passThrough(t.schema),
      annotations: t.annotations,
      _meta: t.meta,
    },
    async (args: Obj, ctx: ServerContext) => {
      try {
        return await t.run(args, ctx);
      } catch (e) {
        return errorOf(e);
      }
    },
  );
}

const asEntry = (s: BridgeService, i: number) =>
  s instanceof Client ? { client: s, url: `service #${i + 1}` } : s;

/**
 * Greet the services and build their tools, once per process. Refuses to start if two services
 * claim one id. The returned factory makes a server per call (`serveStdio` and
 * `createMcpHandler` call it more than once); the pending proposals live here, shared by all.
 */
export async function bridge(
  services: BridgeService[],
  o: BridgeOptions = {},
): Promise<BridgeFactory> {
  const mode = o.tools ?? 'auto';
  const b: Bridge = {
    pending: new PendingProposals(),
    consents: o.consents ?? homeConsents,
    budget: o.budget ?? 1500,
    tighten: o.tighten ?? {},
    now: o.now ?? unixNow,
  };
  const { services: greeted, problems } = await greet(services.map(asEntry));
  const byId = new Map(greeted.map((s) => [s.id, s]));
  const remote = await buildTools(b, greeted, mode);
  const tools = [...remote, ...utilityTools(b, byId)];
  const instructions = instructionsFor(greeted, remote, {
    mode,
    budget: b.budget,
    problems,
  });
  const factory = () => {
    const server = new McpServer(
      { name: 'yea-bridge', version: VERSION },
      { instructions, capabilities: { tools: {} } },
    );

    for (const t of tools) {
      register(server, t);
    }

    return server;
  };

  return Object.assign(factory, {
    instructions,
    tools: remote.map((t) => t.name),
  });
}
