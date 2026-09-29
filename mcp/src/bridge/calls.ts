/**
 * The bridge's read calls (SPEC-bridge, "Read tools, expand and undo"): `ASK` for a read tool,
 * and the result an ANSWER becomes. The service checks the agent's proof and grants.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { type Answer, type ErrorReply, printable } from '@yea-protocol/sdk';
import type { Obj } from '../util.js';
import type { Service } from './greet.js';
import { replyResult } from './lens.js';

/** An ANSWER, and how to fetch what it elided. */
export function answerResult(
  svc: Service,
  r: Answer | ErrorReply,
): CallToolResult {
  const more =
    r.kind === 'ANSWER' && r.more?.length
      ? [
          `→ call yea_expand with service "${printable(svc.id)}" and one of the handles above for the rest.`,
        ]
      : [];

  return replyResult(
    r,
    r.kind === 'ANSWER' ? { data: r.data } : undefined,
    more,
  );
}

/** A read tool: `ASK` with the params and the bridge's budget. */
export async function readCall(
  svc: Service,
  o: { capability: string; params: Obj; budget: number },
): Promise<CallToolResult> {
  return answerResult(
    svc,
    await svc.client.ask(o.capability, o.params, { budget: o.budget }),
  );
}
