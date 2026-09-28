/**
 * The bridge's read tools and utilities (SPEC-bridge, "Read tools, expand and undo", and
 * `yea_consent`). Each sends one verb; the service checks the agent's proof and grants. The
 * utility tools' specs (`yea_consent`, `yea_expand`, `yea_undo`) are built here too.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { type Answer, type ErrorReply, printable } from '@yea-protocol/sdk';
import {
  errorResult,
  READ_ANNOTATIONS,
  textResult,
  UNDO_ANNOTATIONS,
} from '../result.js';
import type { Obj } from '../util.js';
import { type ConsentStore, checkConsent, readConsent } from './consent.js';
import type { Service } from './greet.js';
import type { Bridge } from './job.js';
import type { Pending, PendingProposals } from './pending.js';
import { replyResult } from './render.js';
import type { ToolSpec } from './types.js';

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

const consentRefused = (why: string) =>
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
    return consentRefused(shape.why);
  }

  const entry = entryFor(c, token);
  const agent = entry ? c.services.get(entry.service)?.agent : null;

  if (!entry || !agent) {
    return consentRefused(
      'it is for no pending proposal (it may have expired, or the bridge restarted: call the tool again for fresh proposals and codes)',
    );
  }

  if (entry.refused.has(token as string)) {
    return consentRefused(
      'this consent was refused by the service when it was used; ask the user to approve the code again',
    );
  }

  const o = { entry, agent, now: c.now };
  const check = await checkConsent(token, o);

  if (!check.ok) {
    return consentRefused(check.why);
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
    return consentRefused(
      'a different valid consent for this proposal is already saved',
    );
  }

  c.consents.put(o.proposal.hash, token);

  return textResult(
    [
      `✓ consent saved for [${printable(o.proposal.id)}] ${printable(o.proposal.summary)} at ${printable(o.entry.service)}. Call ${o.entry.tool} again with the same arguments to commit it.`,
    ],
    { proposal: o.proposal.id, tool: o.entry.tool },
  );
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
export function utilityTools(
  b: Bridge,
  services: Map<string, Service>,
): ToolSpec[] {
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
