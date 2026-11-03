/**
 * `@yea-protocol/mcp/bridge`: YEA services as MCP tools, one per remote capability
 * (docs/framework/SPEC-bridge.md). `yea mcp` runs it over stdio.
 *
 * The bridge has no policy of its own: each service checks the agent's grants, auto-commits
 * what they allow, and demands a consent grant for the rest (SPEC.md §4.3.1, §6.6). The bridge
 * shows the proposals, hands out consent codes for `yea approve`, relays the signed consent,
 * and commits.
 *
 * It never asks in the client and never signs: nothing here loads a principal key, because an
 * approval triggered from inside the chat client is form tier, whichever key signs it (decision
 * 4; SPEC-approval §9).
 */
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { Client, type ConsentStore, unixNow } from '@yea-protocol/sdk';
import { home, homeConsents, homePending } from '@yea-protocol/sdk/node';
import { greet } from './bridge/greet.js';
import { instructionsFor } from './bridge/instructions.js';
import { passThrough } from './bridge/params.js';
import { PendingProposals } from './bridge/pending.js';
import type { Bridge } from './bridge/state.js';
import { buildTools, errorOf, utilityTools } from './bridge/tools.js';
import type { ToolMode, ToolSpec } from './bridge/types.js';
import { interactionMeta } from './result.js';
import type { Obj } from './util.js';

export type { ConsentStore } from '@yea-protocol/sdk';
export type { ToolMode } from './bridge/types.js';

const VERSION = '0.1.0';

export interface BridgeOptions {
  /** `generic` or `per-capability` for every service; default: generic past 25 capabilities. */
  tools?: ToolMode;
  /** The token budget for reads, expands and proposals. Default 1500. */
  budget?: number;
  /**
   * The agent's home directory: `policy.json` and the default consent store live in it. Default
   * `YEA_HOME`, else `~/.yea`, resolved once. The principal key is never read from it.
   */
  home?: string;
  /** Where consents are kept. Default: the home's `consents` directory. */
  consents?: ConsentStore;
  /** Unsigned tightening, merged with the home's `policy.json`; only `deny` applies. */
  tighten?: { deny?: string[] };
  /**
   * Mark the tools that change things (intents and `yea_undo`) with
   * `_meta['anthropic/requiresUserInteraction']`: Claude Code then prompts for every call, even
   * in `auto` or `bypassPermissions`, and denies them in `claude -p`. Default false.
   */
  requireInteraction?: boolean;
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

/** With `prompt` on, a tool marked destructive gets Claude Code's prompt on every call. */
const metaOf = (t: ToolSpec, prompt: boolean) => ({
  ...t.meta,
  ...interactionMeta(prompt && t.annotations.destructiveHint === true),
});

/** Register one tool; anything it throws becomes a tool error, not a crash. */
function register(server: McpServer, t: ToolSpec, prompt: boolean) {
  server.registerTool(
    t.name,
    {
      description: t.description,
      inputSchema: passThrough(t.schema),
      annotations: t.annotations,
      _meta: metaOf(t, prompt),
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
  // The one place the home is resolved; everything below is handed it.
  const dir = o.home ?? home();
  const b: Bridge = {
    pending: new PendingProposals(homePending(dir)),
    consents: o.consents ?? homeConsents(dir),
    budget: o.budget ?? 1500,
    tighten: o.tighten ?? {},
    home: dir,
    now: o.now ?? unixNow,
  };
  const { services: greeted, problems } = await greet(services.map(asEntry));

  // Codes from a bridge that has ended are for proposals no one holds now (decision 3).
  b.pending.clearOrphans();

  const byId = new Map(greeted.map((s) => [s.id, s]));
  const remote = await buildTools(b, greeted, mode);
  const tools = [...remote, ...utilityTools(b, byId)];
  const instructions = instructionsFor(greeted, remote, {
    budget: b.budget,
    problems,
  });
  const factory = () => {
    const server = new McpServer(
      { name: 'yea-bridge', version: VERSION },
      { instructions, capabilities: { tools: {} } },
    );

    for (const t of tools) {
      register(server, t, o.requireInteraction ?? false);
    }

    return server;
  };

  return Object.assign(factory, {
    instructions,
    tools: remote.map((t) => t.name),
  });
}
