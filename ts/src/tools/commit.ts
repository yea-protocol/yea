/**
 * The `yea_commit` tool: commit a proposal the model was shown through the consent round, which
 * routes a required consent to the human, built from that proposal and never from the service's
 * error. A consent the human doesn't give here becomes a code for `yea approve`.
 */
import { outOfBand, signer } from '../approvers.js';
import type { Client } from '../client.js';
import {
  type Approver,
  consentRound,
  type RoundOutcome,
} from '../consent-round.js';
import { homeConsents, principalKey } from '../home.js';
import { untrustedLens } from '../lens.js';
import { printable } from '../text.js';
import type { Event } from '../types.js';
import type { Confirm, HostState, ToolArgs, ToolResult } from './state.js';

export async function commitTool(
  s: HostState,
  c: Client,
  a: ToolArgs,
): Promise<ToolResult> {
  const events: string[] = [];
  const onEvent = (e: Event) => events.push(untrustedLens(e));
  const known = s.seen.get(a.proposal);

  if (!known || known.service !== a.service) {
    return {
      text: `✗ not_found: unknown proposal ${a.proposal} at ${a.service}; call yea_intent first`,
      isError: true,
    };
  }

  const out = await consentRound({
    client: c,
    proposal: known.proposal,
    approver: humanApprover(s.approve),
    consents: homeConsents,
    onEvent,
  });

  return resultOf(out, events);
}

/**
 * Ask the human through `approve` when the principal key the consent is for is here, and sign
 * on a yes; otherwise, or on a no, hand back a code for `yea approve`.
 */
const humanApprover =
  (approve: Confirm | undefined): Approver =>
  async (ask) => {
    const principal = await principalKey();

    if (!approve || !principal || principal.public !== ask.request.principal) {
      return outOfBand()(ask);
    }

    const a = await signer(principal, (k) =>
      approve({
        service: printable(k.request.service),
        shown: k.lines.join('\n'),
        reason: k.reason,
      }),
    )(ask);

    return 'declined' in a ? outOfBand()(ask) : a;
  };

/** The tool result for how the round ended. */
function resultOf(out: RoundOutcome, events: string[]): ToolResult {
  const lens = untrustedLens(out.reply);

  if (out.kind === 'reply') {
    return {
      text: [...events, lens].join('\n'),
      isError: out.reply.kind === 'ERROR',
    };
  }

  const then =
    out.kind === 'pending'
      ? `the user did not approve this here. If they want it, ask them to review it and run, in their own terminal: yea approve ${out.code}  — then call yea_commit again.`
      : out.kind === 'refused'
        ? `not asking the user to sign the service's consent request: ${out.why}.`
        : 'the user did not approve this.';

  return { text: `${lens}\n  → ${then}`, isError: true };
}
