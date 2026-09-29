/**
 * Step 3 of a job call (SPEC-bridge): a call whose proposals are already pending. It commits a
 * proposal with the agent's grants plus a saved consent, or hands back the same proposals and
 * codes. It signs nothing: consents come only from `yea_consent` or `yea approve` (TODO(#73)).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  type Client,
  type Proposal,
  printable,
  untrustedLens,
} from '@yea-protocol/sdk';
import { NOTHING_RAN, refused } from '../../result.js';
import { checkConsent, consentId } from '../consent.js';
import { replyResult } from '../lens.js';
import { proposalsResult, receiptOutcome } from '../outcomes.js';
import { approvable, type Pending } from '../pending.js';
import { expiringNote } from '../proposals.js';
import type { Bridge } from '../state.js';
import type { JobCall } from '../types.js';

/** Errors after which the pending proposals are gone, so a fresh INTENT is the way on. */
const STALE = new Set(['not_found', 'expired', 'conflict']);

/** COMMIT, retried once as is if it fails in transport: it's idempotent (SPEC.md §4.4). */
async function commitOnce(c: Client, p: Proposal, extra: string[]) {
  const events: string[] = [];
  const o = {
    grants: extra,
    onEvent: (e: Parameters<typeof untrustedLens>[0]) =>
      events.push(untrustedLens(e)),
  };
  let r: Awaited<ReturnType<Client['commit']>>;

  try {
    r = await c.commit(p, o);
  } catch {
    r = await c.commit(p, o);
  }

  return { r, events };
}

/**
 * Step 3, with pending proposals. A call naming `proposal` acts on that proposal only: it commits
 * with the agent's grants, plus that proposal's own consent if one is saved. Otherwise a saved
 * consent commits its proposal, or the same proposals and codes come back. Null means the entry
 * went stale: go on to step 4.
 */
export async function pendingCall(
  b: Bridge,
  call: JobCall,
  entry: Pending,
): Promise<CallToolResult | null> {
  if (call.proposal !== undefined) {
    const p = entry.proposals.find((x) => x.id === call.proposal);

    return p
      ? commitPending(b, call, {
          entry,
          p,
          consent: await usableConsent(b, call, { entry, p }),
        })
      : refused(
          `${printable(call.proposal)} is not one of this call's proposals (${entry.proposals.map((x) => printable(x.id)).join(', ')})`,
        );
  }

  for (const p of entry.proposals) {
    const consent = await usableConsent(b, call, { entry, p });

    if (consent) {
      return commitPending(b, call, { entry, p, consent });
    }
  }

  const coded = entry.proposals.filter((p) => approvable(p, b.now()));

  // Nothing left to approve here: rather than wait out the last minutes, start over.
  if (!coded.length) {
    b.pending.drop(entry.key);

    return null;
  }

  return proposalsResult(
    { ...entry, proposals: coded },
    'still waiting for approval',
    expiringNote(entry.proposals.length - coded.length, 'pending'),
  );
}

/**
 * The saved consent (from `yea_consent` or `yea approve`) for `p`, if it passes every
 * `yea_consent` check and no COMMIT of this entry has failed with it.
 */
async function usableConsent(
  b: Bridge,
  call: JobCall,
  o: { entry: Pending; p: Proposal },
): Promise<string | null> {
  const agent = call.svc.agent;
  const token = b.consents.get(o.p.hash);

  if (!agent || !token || o.entry.refused.has(await consentId(token))) {
    return null;
  }

  const check = await checkConsent(token, {
    entry: o.entry,
    agent,
    now: b.now(),
  });

  return check.ok && check.proposal.hash === o.p.hash ? token : null;
}

/**
 * Commit a pending proposal with the agent's grants, plus its consent if any. A receipt drops the
 * entry; a stale proposal drops it and returns null. A consent the service refused is never
 * used again for this entry, so the call can't wedge on it; `consent_required` without a consent
 * gives that proposal's code.
 */
async function commitPending(
  b: Bridge,
  call: JobCall,
  commit: { entry: Pending; p: Proposal; consent: string | null },
): Promise<CallToolResult | null> {
  const { entry, p, consent } = commit;
  const { r, events } = await commitOnce(
    call.svc.client,
    p,
    consent ? [consent] : [],
  );

  if (r.kind === 'RECEIPT') {
    b.pending.drop(entry.key);

    return receiptOutcome(r, events);
  }

  if (STALE.has(r.code)) {
    b.pending.drop(entry.key);

    return null;
  }

  if (consent) {
    entry.refused.add(await consentId(consent));

    return replyResult(r, undefined, [
      `The saved consent for [${printable(p.id)}] didn't commit it, so this call won't use it again; ${NOTHING_RAN}. The user can approve its code again, or you can call again later for fresh proposals.`,
    ]);
  }

  if (r.code === 'consent_required') {
    return proposalsResult(
      { ...entry, proposals: [p] },
      `${printable(r.message)}: this needs the user's approval`,
      [],
    );
  }

  return replyResult(r);
}
