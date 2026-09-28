/**
 * The `yea_commit` tool: commit a proposal the model was shown, routing a required consent to the
 * human, built from that proposal and never from the service's error.
 */
import { consentFrom, consentLines } from '../approve.js';
import type { Client } from '../client.js';
import { consentCode, consentGrant } from '../consent.js';
import { keyPair } from '../crypto.js';
import { loadGrants, principalKey, saveGrant } from '../home.js';
import { untrustedLens } from '../lens.js';
import { printable } from '../text.js';
import type { ConsentRequest, ErrorReply, Event, Proposal } from '../types.js';
import type { Approver, HostState, ToolArgs, ToolResult } from './state.js';

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

  const p = known.proposal;
  let r = await c.commit(p, { grants: loadGrants('consents'), onEvent });

  if (r.kind === 'ERROR' && r.code === 'consent_required') {
    const asked = await consentFor(r, c, p);

    if ('why' in asked) {
      return {
        text:
          untrustedLens(r) +
          `\n  → the service's consent request doesn't match this proposal (${asked.why}); not asking the user to sign it.`,
        isError: true,
      };
    }

    const { consent, shown } = asked;
    const token = await askHuman({
      approve: s.approve,
      consent,
      shown,
      err: r,
      c,
    });

    if (!token) {
      return {
        text:
          untrustedLens(r) +
          `\n  → the user did not approve this here. If they want it, ask them to review it and run, in their own terminal: yea approve ${consentCode(consent, p)}  — then call yea_commit again.`,
        isError: true,
      };
    }

    r = await c.commit(p, { grants: [token], onEvent });
  }

  return {
    text: [...events, untrustedLens(r)].join('\n'),
    isError: r.kind === 'ERROR',
  };
}

/**
 * Check the service's consent request against the proposal we showed, and build the consent
 * from that proposal, never from the service's error; with the lines to show the person.
 */
async function consentFor(
  err: ErrorReply,
  c: Client,
  p: Proposal,
): Promise<{ consent: ConsentRequest; shown: string[] } | { why: string }> {
  const k = err.consent;

  if (!k) {
    return { why: 'the service sent none' };
  }

  const view = await consentLines(k, p, await c.audience());

  return 'why' in view
    ? view
    : { consent: consentFrom(k, p), shown: view.lines };
}

/** Route a consent to the human; returns the signed consent grant, or null if not approved. */
async function askHuman(o: {
  approve?: Approver;
  consent: ConsentRequest;
  shown: string[];
  err: ErrorReply;
  c: Client;
}): Promise<string | null> {
  const { approve, consent, c } = o;
  const principal = await principalKey();

  if (
    !approve ||
    !principal ||
    principal.public !== consent.principal ||
    !c.key
  ) {
    return null;
  }

  if (
    !(await approve({
      service: printable(consent.service),
      shown: o.shown.join('\n'),
      reason: printable(o.err.message),
    }))
  ) {
    return null;
  }

  const token = await consentGrant({
    principal,
    agent: (await keyPair(c.key)).public,
    consent,
  });

  saveGrant(token, 'consents', consent.hash);

  return token;
}
