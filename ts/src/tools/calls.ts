/** The `yea_ask`, `yea_intent` and `yea_undo` tools: one client call each, answered as Lens. */
import type { Client } from '../client.js';
import { untrustedLens } from '../lens.js';
import type { HostState, ToolArgs, ToolResult } from './state.js';

export async function askTool(
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

export async function intentTool(
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

export async function undoTool(
  _s: HostState,
  c: Client,
  a: ToolArgs,
): Promise<ToolResult> {
  const r = await c.undo(a.receipt);

  return { text: untrustedLens(r), isError: r.kind === 'ERROR' };
}
