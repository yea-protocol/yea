/**
 * Steps 4–6 of a job call (SPEC-bridge): a fresh INTENT with `auto`. The service commits what
 * the agent's grants allow; the rest become pending proposals with one consent code each.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { type Client, decodeGrant, type Proposals } from '@yea-protocol/sdk';
import { refused } from '../../result.js';
import { codesFor } from '../consent.js';
import { replyResult } from '../lens.js';
import {
  manyPrincipals,
  noGrants,
  proposalsResult,
  receiptOutcome,
} from '../outcomes.js';
import { approvable, type Pending } from '../pending.js';
import { checkProposals, expiringNote } from '../proposals.js';
import type { Bridge } from '../state.js';
import type { JobCall } from '../types.js';

/** Why a fresh call returned proposals: SPEC.md §4.3.1 auto-commits no more than this. */
const AUTO_ONLY =
  "the service commits at once only the first proposal, and only if it's undoable and within the user's grant";

/** Step 4: INTENT with `auto`, so the service commits at once what the agent's grants allow. */
export async function freshCall(
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
    return receiptOutcome(r);
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
