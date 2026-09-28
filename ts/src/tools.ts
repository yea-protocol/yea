/**
 * The generic agent-facing tool surface of `yea test-drive`: four tools whose results are Lens,
 * with consent routed to a human through `approve`. (`yea mcp` builds one tool per capability
 * instead; it lives in `@yea-protocol/mcp/bridge`.)
 * The tools live in tools/; this file greets the services and dispatches calls.
 */
import type { Client } from './client.js';
import { untrustedLens } from './lens.js';
import { INSTRUCTIONS } from './tooldefs.js';
import { askTool, intentTool, undoTool } from './tools/calls.js';
import { commitTool } from './tools/commit.js';
import type {
  Approver,
  HostState,
  ToolArgs,
  ToolFn,
  ToolResult,
} from './tools/state.js';

export { INSTRUCTIONS, TOOLS } from './tooldefs.js';
export type { Approver, ToolResult } from './tools/state.js';

export interface ToolHost {
  instructions: string;
  services: string[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): void;
}

const TOOL_FNS: Record<string, ToolFn> = {
  yea_ask: askTool,
  yea_intent: intentTool,
  yea_undo: undoTool,
  yea_commit: commitTool,
};

export async function createToolHost(
  clients: Client[],
  approve?: Approver,
): Promise<ToolHost> {
  const state: HostState = { services: new Map(), seen: new Map(), approve };
  const { briefs, problems } = await greet(clients, state.services);
  const none =
    'No YEA services are configured. Tell the user to run `npx @yea-protocol/cli add <url>` (or `npx @yea-protocol/cli setup`) and restart.';
  const instructions =
    INSTRUCTIONS +
    (briefs.length ? briefs.join('\n\n') : none) +
    (problems.length ? `\n\n${problems.join('\n')}` : '');

  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const a = args as unknown as ToolArgs;
    const c = state.services.get(a.service);

    if (!c) {
      return {
        text: `✗ unknown service ${JSON.stringify(a.service)}; known: ${[...state.services.keys()].join(', ')}`,
        isError: true,
      };
    }

    const tool = Object.hasOwn(TOOL_FNS, name) ? TOOL_FNS[name] : undefined;

    if (!tool) {
      return { text: `✗ unknown tool ${name}`, isError: true };
    }

    return tool(state, c, a);
  }

  return {
    instructions,
    services: [...state.services.keys()],
    call,
    close: () => {
      for (const c of clients) {
        c.close();
      }
    },
  };
}

/** HELLO every client, registering the reachable ones by service id. */
async function greet(clients: Client[], services: Map<string, Client>) {
  const briefs: string[] = [];
  const problems: string[] = [];

  for (const c of clients) {
    try {
      const b = await c.hello(1500);

      if (b.kind !== 'BRIEF') {
        throw new Error(untrustedLens(b));
      }

      services.set(b.service.id, c);
      briefs.push(untrustedLens(b));
    } catch (e) {
      problems.push(
        `(a service could not be reached: ${(e as Error).message})`,
      );
    }
  }

  return { briefs, problems };
}
