/**
 * Approvers for the consent round (consent-round.ts): how a person's consent is given. A signer
 * asks the person here and signs with the principal key it holds; out of band hands back a
 * consent code for `yea approve` wherever that key is. The round checks what either returns.
 */

import { consentCode, consentGrant, consentRequest } from './consent.js';
import type { Approver, ConsentAsk } from './consent-round.js';
import type { KeyPair } from './crypto.js';
import type { Proposal } from './types.js';

/**
 * Ask the person with `confirm` (the terminal, test-drive, a page) and, only on an explicit
 * yes, sign the consent the round asked for with `principal`, issued to the asking agent.
 */
export const signer =
  (
    principal: KeyPair,
    confirm: (ask: ConsentAsk) => Promise<boolean>,
  ): Approver =>
  async (ask) =>
    (await confirm(ask))
      ? {
          grant: await consentGrant({
            principal,
            agent: ask.agent,
            consent: ask.request,
          }),
        }
      : { declined: true };

/** Ask no one here: hand back a consent code carrying the proposal, for `yea approve`. */
export const outOfBand =
  (): Approver =>
  async ({ request, proposal, agent }) => ({
    pending: consentCode(request, proposal, { agent }),
  });

/**
 * A consent code for `p` before any COMMIT, as the bridge hands out with a job's proposals
 * (SPEC-bridge, step 6): its request is built from `p` and the principal the agent's grants
 * name, and `yea approve` checks it against `p` as it would the round's.
 */
export const consentCodeFor = (
  p: Proposal,
  o: { service: string; principal: string; agent: string },
) =>
  consentCode(consentRequest(p, o.service, o.principal), p, {
    agent: o.agent,
  });
