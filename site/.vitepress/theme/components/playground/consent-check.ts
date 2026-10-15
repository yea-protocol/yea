/**
 * The playground's consent check: find the proposal the agent committed, and check the
 * service's consent request against it with the SDK's `consentToSign`, which says what to sign
 * (built from that proposal) or why it can't be approved. No Vue here, so it can be tested.
 */
import type { ConsentRequest } from '@yea-protocol/sdk';
import {
  type Core,
  type Exchange,
  SERVICES,
  type ServiceKey,
} from './model.ts';
import { type ReceivedProposal, receivedProposal, type Seen } from './seen.ts';

/** Where the check stands: what to sign once it passes, or why it can't be approved. */
export type ConsentCheck =
  | { state: 'checking' }
  | { state: 'ok'; consent: ConsentRequest }
  | { state: 'refused'; why: string };

/** The proposal the exchange committed: the one the agent received, at that service. */
export function committedProposal(
  seen: Seen,
  x: Exchange,
): ReceivedProposal | null {
  if (x.request.verb !== 'COMMIT') {
    return null;
  }

  const p = receivedProposal(seen, x.request.proposal, x.request.hash);

  return p?.service === x.service ? p : null;
}

/** Check request `c` against `p`, the proposal shown, at the service that sent it. */
export async function checkAgainst(
  sdk: Pick<Core, 'consentToSign'>,
  c: ConsentRequest,
  p: ReceivedProposal,
  service: ServiceKey,
): Promise<ConsentCheck> {
  const { service: _s, committed: _c, ...proposal } = p;
  const r = await sdk.consentToSign(c, proposal, SERVICES[service]);

  return 'why' in r
    ? { state: 'refused', why: r.why }
    : { state: 'ok', consent: r.consent };
}
