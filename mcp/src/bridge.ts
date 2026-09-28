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
import {
  type CallToolResult,
  McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { type Brief, Client, est, printable } from '@yea-protocol/sdk';
import { type ConsentStore, homeConsents } from './bridge/consent.js';
import { greet, type Service } from './bridge/greet.js';
import type { Bridge } from './bridge/job.js';
import { passThrough } from './bridge/params.js';
import { PendingProposals } from './bridge/pending.js';
import { clip, safeLens } from './bridge/render.js';
import {
  buildTools,
  errorOf,
  isGeneric,
  type ToolMode,
  type ToolSpec,
} from './bridge/tools.js';
import { consentCall, expandCall, undoCall } from './bridge/utility.js';
import { errorResult, READ_ANNOTATIONS, UNDO_ANNOTATIONS } from './result.js';
import type { Obj } from './util.js';

export type { ConsentStore } from './bridge/consent.js';
export type { ToolMode } from './bridge/tools.js';

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

const HEADER = `YEA acts for the user under a policy they signed. Each capability of the services below is its own tool.
- Read-only tools never change anything. Tools marked destructive do things: call one with what the user asked for (names and days are fine; no lookups needed). It commits at once when the user's grant allows it (a ✓ receipt). Otherwise it returns proposals, and nothing has happened.
- A proposal over the grant comes with a consent code: ask the user to run \`yea approve <code>\` where their principal key is (the result says when to add \`--to\`) and paste the printed consent back, pass it to yea_consent, then call the same tool again with the same arguments. Never split or restructure a purchase to get under a limit.
- \`proposal: "<id>"\` commits one of the proposals, if the grant allows it; \`preview: true\` only shows them. Commit only what the user asked for.
- yea_undo undoes a receipt within its window; yea_expand fetches the rest of an elided result.`;

const NONE =
  'No YEA services are configured. Tell the user to run `npx @yea-protocol/cli add <url>` and restart.';

/** A service's part of the instructions; a generic one lists its capabilities (fitted). */
/**
 * A generic service's capabilities as its BRIEF's Lens, from the BRIEF kept at start-up: as
 * many full lines as fit `budget`, then the rest by name only.
 */
function capabilityList(svc: Service, budget: number): string {
  const brief: Brief = {
    ...svc.brief,
    capabilities: svc.capabilities.map((c) => ({
      ...c,
      summary: clip(c.summary),
    })),
    more: undefined,
  };
  const lines = safeLens(brief).split('\n');
  const head = lines.length - svc.capabilities.length;
  const kept = lines.slice(0, head);
  let used = est(kept.join('\n'));

  for (const line of lines.slice(head)) {
    used += est(line) + 1;

    if (used > budget) {
      break;
    }

    kept.push(line);
  }

  const rest = svc.capabilities.slice(kept.length - head).map((c) => c.name);

  return rest.length
    ? `${kept.join('\n')}\n… ${rest.length} more: ${clip(rest.join(', '), budget * 4)}`
    : kept.join('\n');
}

function serviceNote(
  svc: Service,
  o: { generic: boolean; tools: string[]; budget: number },
): string {
  if (!o.generic) {
    return `# ${clip(svc.name, 100)} (${clip(svc.id, 100)})\n${clip(svc.summary)}`;
  }

  return `${capabilityList(svc, o.budget)}\nUse ${o.tools.join(' and ')} with a capability from this list.`;
}

function instructionsFor(
  services: Service[],
  specs: ToolSpec[],
  o: { mode: ToolMode; budget: number; problems: string[] },
): string {
  const notes = services.map((svc) =>
    serviceNote(svc, {
      generic: isGeneric(svc, o.mode),
      tools: specs
        .filter((t) => t.meta['dev.yea/service'] === svc.id)
        .map((t) => t.name),
      budget: o.budget,
    }),
  );

  return [HEADER, notes.length ? notes.join('\n\n') : NONE, ...o.problems]
    .join('\n\n')
    .trim();
}

const str = (description: string) => ({ type: 'string', description });

const object = (properties: Obj, required: string[]) => ({
  type: 'object',
  properties,
  required,
});

/** The service a utility call names, or an error listing the ones there are. */
function serviceFor(
  services: Map<string, Service>,
  id: unknown,
): Service | CallToolResult {
  const svc = typeof id === 'string' ? services.get(id) : undefined;

  return (
    svc ??
    errorResult([
      `✗ unknown service ${printable(JSON.stringify(id) ?? '')}; known: ${[...services.keys()].map(printable).join(', ')}`,
    ])
  );
}

const isResult = (v: Service | CallToolResult): v is CallToolResult =>
  'content' in v;

/** A utility's handler that needs a known service and one string field. */
function withService(
  services: Map<string, Service>,
  field: string,
  run: (svc: Service, v: string) => Promise<CallToolResult>,
) {
  return async (args: Obj) => {
    const svc = serviceFor(services, args.service);

    if (isResult(svc)) {
      return svc;
    }

    return typeof args[field] === 'string'
      ? run(svc, args[field])
      : errorResult([`✗ ${field} must be a string`]);
  };
}

/** `yea_consent`: only saves a consent `yea approve` signed; it signs and commits nothing. */
const consentTool = (b: Bridge, services: Map<string, Service>): ToolSpec => ({
  name: 'yea_consent',
  description:
    'Hand back a consent the user signed with `yea approve` (a pg1. token they paste to you). It is only saved; then call the same tool again to commit.',
  schema: object({ token: str('The pg1. consent `yea approve` printed.') }, [
    'token',
  ]),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  meta: {},
  run: (args) =>
    consentCall(
      { pending: b.pending, consents: b.consents, services, now: b.now() },
      args.token,
    ),
});

/** `yea_consent`, `yea_expand` and `yea_undo`. */
function utilityTools(b: Bridge, services: Map<string, Service>): ToolSpec[] {
  return [
    consentTool(b, services),
    {
      name: 'yea_expand',
      description:
        'Fetch the rest of an elided result, by its handle (EXPAND h_…).',
      schema: object(
        { service: str('The service id.'), handle: str('The handle, h_….') },
        ['service', 'handle'],
      ),
      annotations: READ_ANNOTATIONS,
      meta: {},
      run: withService(services, 'handle', (svc, handle) =>
        expandCall(svc, { handle, budget: b.budget }),
      ),
    },
    {
      name: 'yea_undo',
      description: 'Undo a receipt within its undo window.',
      schema: object(
        {
          service: str('The service id.'),
          receipt: str('The receipt id, r_….'),
        },
        ['service', 'receipt'],
      ),
      annotations: UNDO_ANNOTATIONS,
      meta: {},
      run: withService(services, 'receipt', undoCall),
    },
  ];
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
    now: o.now ?? (() => Math.floor(Date.now() / 1000)),
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
