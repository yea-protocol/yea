/**
 * The generic agent-facing tool surface of `yea test-drive`: four tools whose results are Lens,
 * with consent routed to a human through `approve`. (`yea mcp` builds one tool per capability
 * instead; it lives in `@yea-protocol/mcp/bridge`.)
 */

import { consentFrom, consentLines } from './approve.js';
import type { Client } from './client.js';
import { consentCode, consentGrant } from './consent.js';
import { keyPair } from './crypto.js';
import { loadGrants, principalKey, saveGrant } from './home.js';
import { untrustedLens } from './lens.js';
import { printable } from './text.js';
import { INSTRUCTIONS } from './tooldefs.js';
import type { ConsentRequest, ErrorReply, Event, Proposal } from './types.js';

export { INSTRUCTIONS, TOOLS } from './tooldefs.js';

/**
 * Ask the human to approve `shown`: `at <service>:` and the proposal's Lens, escaped, as are
 * `service` and `reason`. Resolve true only on explicit approval.
 */
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

async function askTool(
  _s: HostState,
  c: Client,
  a: ToolArgs,
): Promise<ToolResult> {
  const budget = a.budget ?? 1500;

  if (a.handle) {
    return { text: untrustedLens(await c.expand(a.handle, { budget })) };
  }

  if (!a.capability) {
    return { text: untrustedLens(await c.hello(budget)) };
  }

  return {
    text: untrustedLens(await c.ask(a.capability, a.params ?? {}, { budget })),
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

  return { text: untrustedLens(r), isError: r.kind === 'ERROR' };
}

async function undoTool(
  _s: HostState,
  c: Client,
  a: ToolArgs,
): Promise<ToolResult> {
  const r = await c.undo(a.receipt);

  return { text: untrustedLens(r), isError: r.kind === 'ERROR' };
}

async function commitTool(
  s: HostState,
  c: Client,
  a: ToolArgs,
): Promise<ToolResult> {
  const events: string[] = [];
  const onEvent = (e: Event) => events.push(untrustedLens(e));
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
    const asked = await consentFor(r, c, p);

    if ('why' in asked) {
      return {
        text:
          untrustedLens(r) +
          `\n  → the service's consent request doesn't match this proposal (${asked.why}); not asking the user to sign it.`,
        isError: true,
      };
    }

    const { consent, shown } = asked;
    const token = await askHuman({
      approve: s.approve,
      consent,
      shown,
      err: r,
      c,
    });

    if (!token) {
      return {
        text:
          untrustedLens(r) +
          `\n  → the user did not approve this here. If they want it, ask them to review it and run, in their own terminal: yea approve ${consentCode(consent, p)}  — then call yea_commit again.`,
        isError: true,
      };
    }

    r = await c.commit(p, { grants: [token], onEvent });
  }

  return {
    text: [...events, untrustedLens(r)].join('\n'),
    isError: r.kind === 'ERROR',
  };
}

/**
 * Check the service's consent request against the proposal we showed, and build the consent
 * from that proposal, never from the service's error; with the lines to show the person.
 */
async function consentFor(
  err: ErrorReply,
  c: Client,
  p: Proposal,
): Promise<{ consent: ConsentRequest; shown: string[] } | { why: string }> {
  const k = err.consent;

  if (!k) {
    return { why: 'the service sent none' };
  }

  const view = await consentLines(k, p, await c.audience());

  return 'why' in view
    ? view
    : { consent: consentFrom(k, p), shown: view.lines };
}

/** Route a consent to the human; returns the signed consent grant, or null if not approved. */
async function askHuman(o: {
  approve?: Approver;
  consent: ConsentRequest;
  shown: string[];
  err: ErrorReply;
  c: Client;
}): Promise<string | null> {
  const { approve, consent, c } = o;
  const principal = await principalKey();

  if (
    !approve ||
    !principal ||
    principal.public !== consent.principal ||
    !c.key
  ) {
    return null;
  }

  if (
    !(await approve({
      service: printable(consent.service),
      shown: o.shown.join('\n'),
      reason: printable(o.err.message),
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
