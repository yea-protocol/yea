/**
 * How a job tool call runs (SPEC-bridge, steps 1–6). The service decides: its grant check
 * auto-commits what the agent's grants allow and demands a consent for the rest. The bridge
 * shows the proposals, relays consents, and commits; it has no policy of its own beyond the
 * person's unsigned `deny`, which only tightens.
 *
 * This file is the flow (steps 1–2 and the branch into 3 or 4); job/pending.ts is step 3,
 * a call with pending proposals, and job/fresh.ts steps 4–6, a fresh INTENT.
 *
 * TODO(#73): `--approve-here` (steps 6–7: a form in the client, then signing with a principal
 * key on this machine) waits for James (decision 4). Until then this file signs nothing: it
 * never loads a principal key, and consent codes are the only way to approve.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { printable } from '@yea-protocol/sdk';
import { readTighteningFor } from '../policy.js';
import { errorResult, NOTHING_RAN, refused, textResult } from '../result.js';
import { freshCall } from './job/fresh.js';
import { pendingCall } from './job/pending.js';
import { proposalsLens, proposalView, replyResult } from './lens.js';
import { pendingKey } from './pending.js';
import { checkProposals } from './proposals.js';
import type { Bridge } from './state.js';
import type { JobCall } from './types.js';

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
