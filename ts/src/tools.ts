/**
 * The agent-facing tool surface shared by the MCP bridge and `yea test-drive`:
 * four tools whose results are Lens, with consent routed to a human through `approve`.
 */

import type { Client } from './client.js';
import { keyPair, proposalHash } from './crypto.js';
import { consentCode, consentGrant } from './grants.js';
import { loadGrants, principalKey, saveGrant } from './home.js';
import { lens } from './lens.js';
import type { ConsentRequest, ErrorReply, Proposal } from './types.js';
import { isUses } from './uses.js';

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
});

export const INSTRUCTIONS =
  "YEA acts for the user under their signed policy. To do something, call yea_intent with the user's goal (names, days are fine: no lookups needed) " +
  'and auto:true if they asked for exactly this; it finishes in one call when the policy allows. yea_ask is for questions. If approval is needed, tell the user.\n\n';

export const TOOLS = [
  {
    name: 'yea_ask',
    description:
      'Read (never changes anything). Pass `handle` to expand an elided result.',
    inputSchema: obj(
      {
        service: str,
        capability: str,
        params: { type: 'object' },
        handle: str,
        budget: { type: 'integer' },
      },
      ['service'],
    ),
  },
  {
    name: 'yea_intent',
    description:
      "Do something: the user's goal as params (names, days are fine). auto:true finishes now if their policy allows; else returns proposals (effects, uses, risk, undo) or a question.",
    inputSchema: obj(
      {
        service: str,
        capability: str,
        params: { type: 'object' },
        goal: str,
        auto: { type: 'boolean' },
        budget: { type: 'integer' },
      },
      ['service', 'capability'],
    ),
  },
  {
    name: 'yea_commit',
    description:
      'Execute a proposal by id, exactly as shown. Only what the user wants.',
    inputSchema: obj({ service: str, proposal: str }, ['service', 'proposal']),
  },
  {
    name: 'yea_undo',
    description: 'Undo a receipt within its undo window.',
    inputSchema: obj({ service: str, receipt: str }, ['service', 'receipt']),
  },
];

/** Ask the human to approve `shown` (the proposal's Lens). Resolve true only on explicit approval. */
export type Approver = (req: {
  service: string;
  shown: string;
  reason: string;
}) => Promise<boolean>;

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ToolHost {
  instructions: string;
  services: string[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): void;
}

/** Tool arguments as the model sends them (see TOOLS); unchecked, like any model output. */
interface ToolArgs {
  service: string;
  capability: string;
  params?: Record<string, unknown>;
  handle?: string;
  goal?: string;
  auto?: unknown;
  budget?: number;
  proposal: string;
  receipt: string;
}

interface HostState {
  services: Map<string, Client>;
  // Remember each proposal as shown, so the model only handles short ids while COMMIT
  // (and any consent) still binds to exactly what was shown.
  seen: Map<string, { service: string; proposal: Proposal }>;
  approve?: Approver;
}

type ToolFn = (s: HostState, c: Client, a: ToolArgs) => Promise<ToolResult>;

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
        throw new Error(b.lens);
      }

      services.set(b.service.id, c);
      briefs.push(b.lens);
    } catch (e) {
      problems.push(
        `(a service could not be reached: ${(e as Error).message})`,
      );
    }
  }

  return { briefs, problems };
}

async function askTool(
  _s: HostState,
  c: Client,
  a: ToolArgs,
): Promise<ToolResult> {
  const budget = a.budget ?? 1500;

  if (a.handle) {
    return { text: (await c.expand(a.handle, { budget })).lens };
  }

  if (!a.capability) {
    return { text: (await c.hello(budget)).lens };
  }

  return {
    text: (await c.ask(a.capability, a.params ?? {}, { budget })).lens,
  };
}

async function intentTool(
  s: HostState,
  c: Client,
  a: ToolArgs,
): Promise<ToolResult> {
  const r = await c.intent(a.capability, a.params ?? {}, {
    goal: a.goal,
    budget: a.budget ?? 1500,
    auto: a.auto === true,
  });

  if (r.kind === 'PROPOSALS') {
    for (const p of r.proposals) {
      s.seen.set(p.id, { service: a.service, proposal: p });
    }
  }

  return { text: r.lens, isError: r.kind === 'ERROR' };
}

async function undoTool(
  _s: HostState,
  c: Client,
  a: ToolArgs,
): Promise<ToolResult> {
  const r = await c.undo(a.receipt);

  return { text: r.lens, isError: r.kind === 'ERROR' };
}

async function commitTool(
  s: HostState,
  c: Client,
  a: ToolArgs,
): Promise<ToolResult> {
  const events: string[] = [];
  const onEvent = (e: { lens: string }) => events.push(e.lens);
  const known = s.seen.get(a.proposal);

  if (!known || known.service !== a.service) {
    return {
      text: `✗ not_found: unknown proposal ${a.proposal} at ${a.service}; call yea_intent first`,
      isError: true,
    };
  }

  const p = known.proposal;
  let r = await c.commit(p, { grants: loadGrants('consents'), onEvent });

  if (r.kind === 'ERROR' && r.code === 'consent_required') {
    const consent = await consentFor(r, c, p);

    if (!consent) {
      return {
        text:
          r.lens +
          "\n  → the service's consent request doesn't match this proposal; not asking the user to sign it.",
        isError: true,
      };
    }

    const token = await askHuman({ approve: s.approve, consent, err: r, c, p });

    if (!token) {
      return {
        text:
          r.lens +
          `\n  → the user did not approve this here. If they want it, ask them to review it and run, in their own terminal: yea approve ${consentCode(consent, p)}  — then call yea_commit again.`,
        isError: true,
      };
    }

    r = await c.commit(p, { grants: [token], onEvent });
  }

  return {
    text: [...events, r.lens].join('\n'),
    isError: r.kind === 'ERROR',
  };
}

/** Build the consent only from the proposal we showed, never from the service's error. */
async function consentFor(
  err: ErrorReply,
  c: Client,
  p: Proposal,
): Promise<ConsentRequest | null> {
  const k = err.consent;

  if (
    !k ||
    k.proposal !== p.id ||
    k.hash !== p.hash ||
    k.capability !== p.capability ||
    k.service !== (await c.audience())
  ) {
    return null;
  }

  if (
    (p.uses !== undefined && !isUses(p.uses)) ||
    (await proposalHash(p)) !== p.hash
  ) {
    return null;
  }

  return {
    proposal: p.id,
    hash: p.hash,
    service: k.service,
    capability: p.capability,
    principal: k.principal,
    summary: p.summary,
    expires: Math.min(k.expires, p.expires),
  };
}

/** Route a consent to the human; returns the signed consent grant, or null if not approved. */
async function askHuman(o: {
  approve?: Approver;
  consent: ConsentRequest;
  err: ErrorReply;
  c: Client;
  p: Proposal;
}): Promise<string | null> {
  const { approve, consent, c, p } = o;
  const principal = await principalKey();

  if (
    !approve ||
    !principal ||
    principal.public !== consent.principal ||
    !c.key
  ) {
    return null;
  }

  const shown = lens({
    yea: 1,
    id: '-',
    re: '-',
    kind: 'PROPOSALS',
    proposals: [p],
  })
    .split('\n')
    .slice(1)
    .join('\n');

  if (
    !(await approve({
      service: consent.service,
      shown,
      reason: o.err.message,
    }))
  ) {
    return null;
  }

  const token = await consentGrant({
    principal,
    agent: (await keyPair(c.key)).public,
    consent,
  });

  saveGrant(token, 'consents', consent.hash);

  return token;
}
