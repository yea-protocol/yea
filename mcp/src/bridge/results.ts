/**
 * The tool results a job call ends in (SPEC-bridge steps 3–6): a receipt, or the proposals with
 * a consent code for each and how to approve one, or why none can be committed.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  decodeConsentCode,
  printable,
  type ReceiptReply,
  untrustedLens,
} from '@yea-protocol/sdk';
import { errorResult, NOTHING_RAN, textResult } from '../result.js';
import type { Pending } from './pending.js';
import { proposalsLens, proposalView } from './render.js';
import type { JobCall } from './types.js';

/** How the person approves a code; on another machine they pass this agent's key with `--to`. */
const howToApprove = (agent: unknown) =>
  `Ask the user to run \`yea approve <code>\` where their principal key is (on a machine without this agent's key, add \`--to ${typeof agent === 'string' ? agent : '<agent key>'}\`), then paste the printed consent back to you and call \`yea_consent\` with it, then call this tool again with the same arguments.`;

/** A receipt as a tool result, with any progress events before it. */
export const receiptResult = (r: ReceiptReply, events: string[] = []) =>
  textResult([...events, untrustedLens(r)], { receipt: r.receipt });

/** SPEC.md §4.4: without grants, nothing from this INTENT can ever be committed. */
export function noGrants(call: JobCall, entry: Pending, dropped: string[]) {
  return errorResult(
    [
      `✗ ${NOTHING_RAN}, and these can't be committed: no grant for this agent is sent to ${printable(call.svc.id)}`,
      proposalsLens(entry.proposals),
      ...dropped,
      `Ask the user to run \`yea grant\` for this agent${call.svc.agent ? ` (${call.svc.agent})` : ' (run `yea install` to make its key)'}, then call again.`,
    ],
    { proposals: entry.proposals.map(proposalView), codes: [] },
  );
}

/** Grants from two principals: §4.4 commits need the INTENT's one, so no code can be right. */
export function manyPrincipals(
  entry: Pending,
  principals: string[],
  dropped: string[],
) {
  return errorResult(
    [
      `✗ ${NOTHING_RAN}: the grants sent to ${printable(entry.service)} come from ${principals.length} principals (${principals.join(', ')}), so no consent code can be made. Keep one principal's grants for this agent.`,
      proposalsLens(entry.proposals),
      ...dropped,
    ],
    { proposals: entry.proposals.map(proposalView), codes: [] },
  );
}

/** The proposals, a code for each, and how to approve or commit one. */
export function proposalsResult(
  entry: Pending,
  why: string,
  dropped: string[],
): CallToolResult {
  const codes = entry.codes.filter((c) =>
    entry.proposals.some((p) => p.id === c.proposal),
  );
  const tail = codes.length
    ? [
        howToApprove(decodeConsentCode(codes[0].code).agent),
        ...codes.map((c) => `  code for [${printable(c.proposal)}]: ${c.code}`),
      ]
    : [
        'No consent code can be offered for these (there is no agent key: run `yea install`).',
      ];

  return textResult(
    [
      `${NOTHING_RAN}: ${why}.`,
      proposalsLens(entry.proposals),
      ...dropped,
      ...tail,
      'To commit one the grant may allow (an irreversible one, say), call this tool again with the same arguments and `proposal: "<id>"`.',
    ],
    { proposals: entry.proposals.map(proposalView), codes },
  );
}
