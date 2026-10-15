/**
 * Step 3 of a job call (SPEC-bridge): a call whose proposals are already pending. It commits a
 * proposal through the consent round, with the agent's grants plus a saved consent, or hands
 * back the same proposals and codes. It signs nothing: its approver is out of band, so consents
 * come only from `yea_consent` or `yea approve` (TODO(#73)).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  type Client,
  type ConsentStore,
  consentRound,
  outOfBand,
  type Proposal,
  printable,
  type RoundClient,
  type RoundOutcome,
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

/** The client, with COMMIT retried once as is if it fails in transport: it's idempotent (SPEC.md §4.4). */
const retrying = (c: Client): RoundClient => ({
  key: c.key,
  audience: () => c.audience(),
  commit: (p, o) => c.commit(p, o).catch(() => c.commit(p, o)),
});

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
  const consents = usableConsents(b, call, entry);

  if (call.proposal !== undefined) {
    const p = entry.proposals.find((x) => x.id === call.proposal);

    return p
      ? commitPending(call, { b, entry, p, consents })
      : refused(
          `${printable(call.proposal)} is not one of this call's proposals (${entry.proposals.map((x) => printable(x.id)).join(', ')})`,
        );
  }

  for (const p of entry.proposals) {
    if (await consents.get(p.hash)) {
      return commitPending(call, { b, entry, p, consents });
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
 * The bridge's consent store as this entry may use it: a saved consent (from `yea_consent` or
 * `yea approve`) for one of its proposals, only if it passes every `yea_consent` check and no
 * COMMIT of this entry has failed with it.
 */
function usableConsents(
  b: Bridge,
  call: JobCall,
  entry: Pending,
): ConsentStore {
  return {
    async get(hash) {
      const agent = call.svc.agent;
      const token = await b.consents.get(hash);

      if (!agent || !token || entry.refused.has(await consentId(token))) {
        return null;
      }

      const check = await checkConsent(token, { entry, agent, now: b.now() });

      return check.ok && check.proposal.hash === hash ? token : null;
    },
    put: (hash, token) => b.consents.put(hash, token),
  };
}

/**
 * Commit a pending proposal through the consent round, with its saved consent if any. A receipt
 * drops the entry; a stale proposal drops it and returns null. A consent the service refused is
 * never used again for this entry, so the call can't wedge on it; `consent_required` without a
 * consent gives that proposal's code.
 *
 * That code is the bridge's own (`codesFor`), not the round's `pending` code, which is left
 * unused on purpose: the round's takes its principal from the service's consent request, the
 * bridge's from the agent's grants, so a hostile service can't pick whose key it names (H3).
 */
async function commitPending(
  call: JobCall,
  o: { b: Bridge; entry: Pending; p: Proposal; consents: ConsentStore },
): Promise<CallToolResult | null> {
  const { b, entry, p } = o;
  const events: string[] = [];
  const out = await consentRound({
    client: retrying(call.svc.client),
    proposal: p,
    approver: outOfBand(),
    consents: o.consents,
    onEvent: (e) => events.push(untrustedLens(e)),
  });
  const r = out.reply;

  if (r.kind === 'RECEIPT') {
    b.pending.drop(entry.key);

    return receiptOutcome(r, events);
  }

  if (STALE.has(r.code)) {
    b.pending.drop(entry.key);

    return null;
  }

  if (out.saved) {
    entry.refused.add(await consentId(out.saved));

    return replyResult(r, undefined, [
      `The saved consent for [${printable(p.id)}] didn't commit it, so this call won't use it again; ${NOTHING_RAN}. The user can approve its code again, or you can call again later for fresh proposals.`,
    ]);
  }

  return needsConsent(entry, p, out);
}

/**
 * A round that ended without a consent: the proposal and its code again. The code is the one
 * handed out with it, built from the proposal and the principal of the agent's grants, never
 * from the service's consent request (the round's code takes the principal from that request).
 */
function needsConsent(
  entry: Pending,
  p: Proposal,
  out: RoundOutcome,
): CallToolResult {
  if (out.kind === 'reply' || out.kind === 'declined') {
    return replyResult(out.reply);
  }

  const mismatch =
    out.kind === 'refused'
      ? [
          `The service's consent request for [${printable(p.id)}] can't be approved (${out.why}); the code below is built from the proposal itself.`,
        ]
      : [];

  return proposalsResult(
    { ...entry, proposals: [p] },
    `${printable(out.reply.message)}: this needs the user's approval`,
    mismatch,
  );
}
