/**
 * The round's check on a grant an approver returns: it must be a consent to exactly the request
 * the person was asked about (SPEC.md §6.6), signed by its principal and issued to the agent that
 * commits with it. An approver is an adapter outside the round, so its grant is never trusted.
 */
import { canonical } from '../canonical.js';
import { type Caveat, checkGrant, decodeGrant } from '../grants.js';
import type { ConsentRequest, Proposal } from '../types.js';

/** The caveats of a consent to `k`, exactly as `consentGrant` writes them. */
const consentCaveats = (k: ConsentRequest): Caveat[] => [
  { svc: [k.service] },
  { verbs: ['COMMIT'] },
  { can: [k.capability] },
  { only: k.hash },
  { exp: k.expires },
];

/** A caveat list as a comparable string, in any order. */
const caveatSet = (cs: unknown[]) =>
  cs
    .map((c) => canonical(c))
    .sort()
    .join('\n');

/** Why `token` isn't one block, from `k`'s principal to `agent`, with exactly `k`'s caveats. */
function shapeMismatch(
  token: string,
  k: ConsentRequest,
  agent: string,
): string | null {
  let blocks: ReturnType<typeof decodeGrant>;

  try {
    blocks = decodeGrant(token);
  } catch (e) {
    return `it isn't a readable grant (${(e as Error).message})`;
  }

  if (blocks.length !== 1) {
    return 'a delegated grant is not a consent';
  }

  const { iss, sub, caveats } = blocks[0].p;

  if (iss !== k.principal) {
    return "it isn't signed by the request's principal";
  }

  if (sub !== agent) {
    return "it's issued to another key, not this agent's";
  }

  try {
    return caveatSet(caveats) === caveatSet(consentCaveats(k))
      ? null
      : 'it consents to something other than the request shown';
  } catch {
    return 'it has a caveat with no canonical form';
  }
}

/**
 * Why `token` can't commit `p` as a consent to request `k` for `agent`, or null if it can: its
 * shape first, then its signature, through the same grant check a service runs.
 */
export async function grantMismatch(
  token: string,
  o: { request: ConsentRequest; proposal: Proposal; agent: string },
): Promise<string | null> {
  const k = o.request;
  const why = shapeMismatch(token, k, o.agent);

  if (why) {
    return why;
  }

  const r = await checkGrant(token, {
    service: k.service,
    verb: 'COMMIT',
    capability: k.capability,
    proposal: { hash: k.hash, uses: o.proposal.uses, risk: o.proposal.risk },
    trusted: [k.principal],
    proofKey: o.agent,
  });

  return r.ok ? null : `its check failed: ${r.reason}`;
}
