/**
 * Consents for one plan (SPEC-approval §6): the consent hash that binds a plan to its phrase,
 * and checking a stored consent grant against the one plan it approves.
 */
import { canonical } from '../canonical.js';
import { sha256 } from '../crypto.js';
import { checkGrant } from '../grants.js';
import { blocksOf, caveatOf } from './grant-blocks.js';
import type { HashedPlan } from './plans.js';
import type { Policy } from './policy.js';

/**
 * What a consent grant's `only` binds (§6): the plan and the phrase the person typed for it,
 * so a consent signed for an edited phrase never matches the server's own.
 */
export const consentHashOf = (planHash: string, phrase: string) =>
  sha256(canonical({ plan: planHash, phrase }));

/**
 * Whether a stored consent may run this plan (SPEC-approval §6): it must be a consent grant for
 * exactly this plan and `phrase`, the one the tool names now (`only` = their consent hash, and
 * `exp` present), signed by the pinned principal and issued to the server. A copied policy
 * grant fails the `only` test. `id` is what to consume it by.
 */
export async function checkJobConsent(
  grant: string,
  o: {
    hp: HashedPlan;
    phrase: string;
    policy: Pick<Policy, 'principal' | 'server'>;
    now?: number;
  },
): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
  const hash = await consentHashOf(o.hp.planHash, o.phrase);
  const blocks = await blocksOf(grant);
  // A consent comes straight from the principal: one root block that itself carries `only`
  // and `exp`. A delegated block can't turn another grant (the policy) into a consent.
  const root = blocks?.length === 1 ? blocks[0] : null;
  const has = (k: string, want?: unknown) =>
    !!root?.caveats.some((c) => {
      const v = caveatOf(c, k);

      return v !== undefined && (want === undefined || v === want);
    });

  if (!root || !has('only', hash) || !has('exp')) {
    return { ok: false, why: 'not a consent for this plan' };
  }

  const check = await checkGrant(grant, {
    service: o.policy.server,
    verb: 'COMMIT',
    capability: o.hp.tool,
    ...(o.now === undefined ? {} : { now: o.now }),
    proposal: { hash, uses: o.hp.plan.uses, risk: o.hp.risk },
    trusted: [o.policy.principal],
    proofKey: o.policy.server,
  });

  return check.ok
    ? { ok: true, id: check.id }
    : { ok: false, why: check.reason };
}
