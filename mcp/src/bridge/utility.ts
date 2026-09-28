/**
 * The bridge's read tools and utilities (SPEC-bridge, "Read tools, expand and undo", and
 * `yea_consent`). Each sends one verb; the service checks the agent's proof and grants.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { type Answer, type ErrorReply, printable } from '@yea-protocol/sdk';
import { type ConsentStore, checkConsent, readConsent } from './consent.js';
import type { Service } from './greet.js';
import type { Pending, PendingProposals } from './pending.js';
import { errorResult, replyResult, textOf } from './render.js';

type Obj = Record<string, unknown>;

/** An ANSWER, and how to fetch what it elided. */
function answerResult(svc: Service, r: Answer | ErrorReply): CallToolResult {
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

/** `yea_expand`: the rest of an elided result. The service binds handles to the agent's key. */
export async function expandCall(
  svc: Service,
  o: { handle: string; budget: number },
): Promise<CallToolResult> {
  return answerResult(
    svc,
    await svc.client.expand(o.handle, { budget: o.budget }),
  );
}

/** `yea_undo`: the service checks the window and the principal. */
export async function undoCall(
  svc: Service,
  receipt: string,
): Promise<CallToolResult> {
  const r = await svc.client.undo(receipt);

  return replyResult(
    r,
    r.kind === 'RECEIPT' ? { receipt: r.receipt } : undefined,
  );
}

/** What `yea_consent` works with. */
export interface ConsentContext {
  pending: PendingProposals;
  consents: ConsentStore;
  services: Map<string, Service>;
  now: number;
}

/** The pending entry a consent's `svc`, `can` and `only` name, if any. */
function entryFor(c: ConsentContext, token: unknown): Pending | undefined {
  const f = readConsent(token);

  if ('why' in f) {
    return undefined;
  }

  return c.pending
    .live(c.now)
    .find(
      (e) =>
        e.service === f.svc &&
        e.capability === f.can &&
        e.proposals.some((p) => p.hash === f.only),
    );
}

const refused = (why: string) =>
  errorResult([`✗ consent refused: ${why}; nothing was saved`]);

/**
 * `yea_consent({ token })`: keep a consent from `yea approve` for the pending proposal it names,
 * after every check in SPEC-bridge. It signs nothing and commits nothing.
 */
export async function consentCall(
  c: ConsentContext,
  token: unknown,
): Promise<CallToolResult> {
  const shape = readConsent(token);

  if ('why' in shape) {
    return refused(shape.why);
  }

  const entry = entryFor(c, token);
  const agent = entry ? c.services.get(entry.service)?.agent : null;

  if (!entry || !agent) {
    return refused(
      'it is for no pending proposal (it may have expired, or the bridge restarted: call the tool again for fresh proposals and codes)',
    );
  }

  if (entry.refused.has(token as string)) {
    return refused(
      'this consent was refused by the service when it was used; ask the user to approve the code again',
    );
  }

  const o = { entry, agent, now: c.now };
  const check = await checkConsent(token, o);

  if (!check.ok) {
    return refused(check.why);
  }

  return keepConsent(c, token as string, { ...o, proposal: check.proposal });
}

/** Save a checked consent, unless a different valid one is already kept for that proposal. */
async function keepConsent(
  c: ConsentContext,
  token: string,
  o: {
    entry: Pending;
    agent: string;
    now: number;
    proposal: { id: string; hash: string; summary: string };
  },
): Promise<CallToolResult> {
  const kept = c.consents.get(o.proposal.hash);

  // One that already failed to commit this entry's proposal doesn't block a new approval.
  const blocking =
    kept !== null &&
    kept !== token &&
    !o.entry.refused.has(kept) &&
    (await checkConsent(kept, o)).ok;

  if (blocking) {
    return refused(
      'a different valid consent for this proposal is already saved',
    );
  }

  c.consents.put(o.proposal.hash, token);

  return {
    content: textOf([
      `✓ consent saved for [${printable(o.proposal.id)}] ${printable(o.proposal.summary)} at ${printable(o.entry.service)}. Call ${o.entry.tool} again with the same arguments to commit it.`,
    ]),
    structuredContent: { proposal: o.proposal.id, tool: o.entry.tool },
  };
}
