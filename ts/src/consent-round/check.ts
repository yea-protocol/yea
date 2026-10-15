/**
 * The consent round's checks on what a service sent (SPEC.md §5.1, §6.6): the proposal must be
 * one a consent can bind, the service's consent request must name it, and what the person is
 * shown and signs is built from that proposal, never taken from the request as it arrived.
 */
import { proposalHash } from '../crypto.js';
import { tooDeepToApprove, untrustedLens } from '../lens.js';
import { isRisk } from '../risk.js';
import { printable } from '../text.js';
import type { ConsentRequest, Proposal } from '../types.js';
import { isUses } from '../uses.js';

/**
 * A proposal as a person is shown it before consenting (SPEC.md §6.6): its Lens without the
 * header line, so its summary, effects, uses, risk, undo and expiry. Never its `data`, which
 * the hash doesn't cover (§5.1). The text comes from the service, so it's re-rendered with
 * `untrustedLens` and each line escaped with `printable`.
 */
export function consentView(p: Proposal): string[] {
  const { data: _unbound, ...bound } = p;

  return untrustedLens({
    yea: 1,
    id: '-',
    re: '-',
    kind: 'PROPOSALS',
    proposals: [bound],
  })
    .split('\n')
    .slice(1)
    .map(printable);
}

/**
 * Why a proposal can't be bound by a consent, or null if it can (SPEC.md §5.1, §6.6): its `uses`
 * must be well formed, its `risk` known, its bound fields shallow enough to show in full, and it must
 * hash to its `hash`. One that canonical JSON can't hash (a float, say) can't be bound either.
 */
export async function checkProposal(p: Proposal): Promise<string | null> {
  if (p.uses !== undefined && !isUses(p.uses)) {
    return 'the proposal has a malformed uses';
  }

  if (!isRisk(p.risk)) {
    return 'the proposal has an unknown risk';
  }

  const { data: _unbound, ...bound } = p;

  if (tooDeepToApprove(bound)) {
    return 'the proposal is nested too deep to show in full';
  }

  try {
    if ((await proposalHash(p)) === p.hash) {
      return null;
    }
  } catch {
    // Unhashable: refused below like any other mismatch.
  }

  return "the proposal doesn't match its hash";
}

/**
 * Why consent request `k` can't be shown for signing against `p`, the proposal the agent got
 * from the service; null when it can (SPEC.md §6.6). Its proposal, hash and capability must
 * be `p`'s, and `p` must pass `checkProposal`. `service` is where `p` came from, when the
 * caller knows it apart from `k` (a consent code carries only its own claim).
 */
export async function checkConsentRequest(
  k: ConsentRequest,
  p: Proposal,
  service?: string,
): Promise<string | null> {
  const checks: [boolean, string][] = [
    [k.proposal !== p.id, 'the consent request names another proposal'],
    [k.hash !== p.hash, "the consent request's hash isn't the proposal's"],
    [
      k.capability !== p.capability,
      'the consent request names another capability',
    ],
    [
      service !== undefined && k.service !== service,
      'the consent request names another service',
    ],
  ];
  const mismatch = checks.find(([bad]) => bad);

  return mismatch ? mismatch[1] : checkProposal(p);
}

/**
 * The consent request to sign for `p`, built from the proposal rather than the service's
 * request: only the service and principal come from `k`, and the expiry is the earlier of the
 * two. Only for a `k` that passed `checkConsentRequest` against `p`.
 */
export const consentFrom = (
  k: ConsentRequest,
  p: Proposal,
): ConsentRequest => ({
  proposal: p.id,
  hash: p.hash,
  service: k.service,
  capability: p.capability,
  principal: k.principal,
  summary: p.summary,
  expires: Math.min(k.expires, p.expires),
});

/** What a person is shown for consent request `k` to proposal `p`: where, then the proposal. */
export const consentLines = (k: ConsentRequest, p: Proposal) => [
  `at ${printable(k.service)}:`,
  ...consentView(p),
];
