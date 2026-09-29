/**
 * The bridge's `yea_consent` (SPEC-bridge, `yea_consent`): its spec, then its handler, which
 * only saves a consent `yea approve` signed, after every check. It signs and commits nothing.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { printable } from '@yea-protocol/sdk';
import { errorResult, textResult } from '../../result.js';
import {
  type ConsentStore,
  checkConsent,
  consentId,
  readConsent,
} from '../consent.js';
import type { Service } from '../greet.js';
import type { Pending, PendingProposals } from '../pending.js';
import type { Bridge } from '../state.js';
import type { ToolSpec } from '../types.js';
import { object, str } from './spec.js';

/** What `yea_consent` works with. */
interface ConsentContext {
  pending: PendingProposals;
  consents: ConsentStore;
  services: Map<string, Service>;
  now: number;
}

/** `yea_consent`: only saves a consent `yea approve` signed; it signs and commits nothing. */
export const consentTool = (
  b: Bridge,
  services: Map<string, Service>,
): ToolSpec => ({
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
async function consentCall(
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

  if (entry.refused.has(await consentId(token as string))) {
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
    !o.entry.refused.has(await consentId(kept)) &&
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
