/**
 * How a job tool call runs (SPEC-bridge, steps 1–6). The service decides: its grant check
 * auto-commits what the agent's grants allow and demands a consent for the rest. The bridge
 * shows the proposals, relays consents, and commits; it has no policy of its own beyond the
 * person's unsigned `deny`, which only tightens.
 *
 * TODO(#73): `--approve-here` (steps 6–7: a form in the client, then signing with a principal
 * key on this machine) waits for James (decision 4). Until then this file signs nothing: it
 * never loads a principal key, and consent codes are the only way to approve.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  type Client,
  decodeGrant,
  type Proposal,
  type Proposals,
  printable,
  untrustedLens,
} from '@yea-protocol/sdk';
import { readTighteningFor } from '../policy.js';
import { errorResult, NOTHING_RAN, refused, textResult } from '../result.js';
import { type ConsentStore, checkConsent, codesFor } from './consent.js';
import {
  approvable,
  type Pending,
  type PendingProposals,
  pendingKey,
} from './pending.js';
import { checkProposals, expiringNote } from './proposals.js';
import { proposalsLens, proposalView, replyResult } from './render.js';
import {
  manyPrincipals,
  noGrants,
  proposalsResult,
  receiptResult,
} from './results.js';
import type { JobCall } from './types.js';

/** What every call shares: the pending proposals, the consent store and the clock. */
export interface Bridge {
  pending: PendingProposals;
  consents: ConsentStore;
  budget: number;
  /** Unsigned tightening merged with `~/.yea/policy.json`; only `deny` applies here. */
  tighten: unknown;
  now(): number;
}

/** Errors after which the pending proposals are gone, so a fresh INTENT is the way on. */
const STALE = new Set(['not_found', 'expired', 'conflict']);

/** Why a fresh call returned proposals: SPEC.md §4.3.1 auto-commits no more than this. */
const AUTO_ONLY =
  "the service commits at once only the first proposal, and only if it's undoable and within the user's grant";

/**
 * Step 1: why the person's unsigned policy refuses this call, or null. `deny` matches the
 * capability or `service/capability`, never the tool name; a policy file that can't be read
 * refuses every job call, since its `deny` can't be known.
 */
function denied(b: Bridge, call: JobCall): string | null {
  const { deny, broken } = readTighteningFor(b.tighten);

  if (broken) {
    return `your unsigned policy can't be used (${broken}), so no job runs until it's fixed`;
  }

  return deny.includes(call.capability) ||
    deny.includes(`${call.svc.id}/${call.capability}`)
    ? `your policy never allows ${printable(call.capability)} at ${printable(call.svc.id)}`
    : null;
}

/** Run a job tool call (SPEC-bridge steps 1–6). */
export async function runJobCall(
  b: Bridge,
  call: JobCall,
): Promise<CallToolResult> {
  const refusal = denied(b, call);

  if (refusal) {
    return refused(refusal);
  }

  if (call.preview) {
    return previewCall(b, call);
  }

  const key = await pendingKey(call.tool, call.capability, call.params);
  const entry = b.pending.get(key, b.now());

  if (entry) {
    const done = await pendingCall(b, call, entry);

    if (done) {
      return done;
    }
  } else if (call.proposal !== undefined) {
    return errorResult([
      `✗ proposal ${printable(call.proposal)} isn't pending for these arguments (it expired, was used, or the bridge restarted); ${NOTHING_RAN}. Call again without proposal for fresh proposals.`,
    ]);
  }

  return freshCall(b, call, key);
}

/** Step 2: the proposals, as Lens; nothing is stored. */
async function previewCall(b: Bridge, call: JobCall): Promise<CallToolResult> {
  const r = await call.svc.client.intent(call.capability, call.params, {
    goal: call.goal,
    budget: b.budget,
  });

  if (r.kind !== 'PROPOSALS') {
    return replyResult(r);
  }

  const { kept, dropped } = await checkProposals(r, call.capability);

  return textResult(
    [
      `preview: ${NOTHING_RAN}`,
      ...(kept.length ? [proposalsLens(kept)] : []),
      ...dropped,
    ],
    { proposals: kept.map(proposalView) },
  );
}

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
async function pendingCall(
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

  if (!agent || !token || o.entry.refused.has(token)) {
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

    return receiptResult(r, events);
  }

  if (STALE.has(r.code)) {
    b.pending.drop(entry.key);

    return null;
  }

  if (consent) {
    entry.refused.add(consent);

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

/** Step 4: INTENT with `auto`, so the service commits at once what the agent's grants allow. */
async function freshCall(
  b: Bridge,
  call: JobCall,
  key: string,
): Promise<CallToolResult> {
  const r = await call.svc.client.intent(call.capability, call.params, {
    goal: call.goal,
    budget: b.budget,
    auto: true,
  });

  if (r.kind === 'RECEIPT') {
    return receiptResult(r);
  }

  if (r.kind !== 'PROPOSALS') {
    return replyResult(r);
  }

  return proposalsFound(b, call, key, r);
}

/** The principals the grants sent to this service are rooted in (SPEC-bridge step 6). */
async function principalsOf(c: Client): Promise<string[]> {
  const iss = (await c.grantsSent()).map((g) => decodeGrant(g)[0].p.iss);

  return [...new Set(iss.filter((x): x is string => typeof x === 'string'))];
}

/**
 * Steps 5–6: check the proposals, keep the ones with at least 2 minutes left pending, and hand
 * out a consent code for each of those, and only those.
 */
async function proposalsFound(
  b: Bridge,
  call: JobCall,
  key: string,
  r: Proposals,
): Promise<CallToolResult> {
  const checked = await checkProposals(r, call.capability);
  const live = checked.kept.filter((p) => approvable(p, b.now()));
  const dropped = [
    ...checked.dropped,
    ...expiringNote(checked.kept.length - live.length),
  ];

  if (!live.length) {
    return refused('no usable proposals', dropped);
  }

  const principals = await principalsOf(call.svc.client);
  const entry: Pending = {
    key,
    tool: call.tool,
    service: call.svc.id,
    capability: call.capability,
    principal: principals.length === 1 ? principals[0] : null,
    proposals: live,
    codes: [],
    refused: new Set(),
  };

  if (!principals.length) {
    return noGrants(call, entry, dropped);
  }

  entry.codes = codesFor(call, entry);
  b.pending.set(entry);

  return principals.length > 1
    ? manyPrincipals(entry, principals, dropped)
    : proposalsResult(entry, AUTO_ONLY, dropped);
}
