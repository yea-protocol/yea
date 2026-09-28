/**
 * The proposals a service returns, as the bridge filters them (SPEC-bridge step 5): the ones
 * that fail the checks a consent would need are dropped, with a line saying why, and ones too
 * close to expiry get a note instead of a code.
 */
import {
  checkProposal,
  type Proposal,
  type Proposals,
} from '@yea-protocol/sdk';

/**
 * Why a proposal fails the checks a consent would need (SPEC.md §6.6), or null: well-typed id,
 * hash and expiry, this tool's capability, then the SDK's `checkProposal` (uses and hash).
 */
async function unsound(
  p: Proposal,
  capability: string,
): Promise<string | null> {
  if (
    typeof p?.id !== 'string' ||
    typeof p.hash !== 'string' ||
    !Number.isSafeInteger(p.expires)
  ) {
    return 'its id, hash or expiry is malformed';
  }

  if (p.capability !== capability) {
    return "its capability isn't this tool's";
  }

  return checkProposal(p);
}

/** Step 5: the proposals that pass, and a line for each that doesn't (never shown otherwise). */
export async function checkProposals(r: Proposals, capability: string) {
  const kept: Proposal[] = [];
  const dropped: string[] = [];

  for (const p of r.proposals) {
    const why = await unsound(p, capability);

    if (why) {
      dropped.push(`✗ dropped a proposal from the service: ${why}`);
    } else {
      kept.push(p);
    }
  }

  return { kept, dropped };
}

/**
 * A line for proposals too close to expiry for a new code: ones that just arrived aren't kept,
 * and pending ones can still be committed with an approval already saved.
 */
export function expiringNote(
  n: number,
  which: 'arrived' | 'pending' = 'arrived',
) {
  if (!n) {
    return [];
  }

  const one = n === 1;
  const tail =
    which === 'arrived'
      ? `so ${one ? "it isn't" : "they aren't"} offered; call again later for fresh ones`
      : 'so no new code is given; an approval already saved still commits until it expires';

  return [
    `✗ ${n} ${which === 'arrived' ? 'proposal' : 'pending proposal'}${one ? '' : 's'} expire${one ? 's' : ''} in under 2 minutes, ${tail}`,
  ];
}
