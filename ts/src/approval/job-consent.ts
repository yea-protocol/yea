/**
 * Consents for one plan (SPEC-approval §6): the consent hash that binds a plan to its phrase,
 * and checking a stored consent grant against the one plan it approves.
 */
import { canonical } from '../canonical.js';
import { sha256 } from '../crypto.js';
import { checkGrant } from '../grants.js';
import { blocksOf, caveatOf } from './grant-blocks.js';
import { effectivePhrase } from './phrase-form.js';
import type { HashedPlan } from './plans.js';
import type { Policy } from './policy.js';

/** Why a stored consent is refused when it isn't shaped like one (§6). */
const NOT_A_CONSENT = 'not a consent for this plan';

/**
 * Why a stored consent is refused when the principal signed it, validly, for another phrase: the
 * tool's phrase changed, or the code the person approved was edited (§6).
 */
export const OTHER_PHRASE = 'not a consent for this phrase';

/**
 * What a consent grant's `only` binds (§6): the plan and the phrase the tool names for it, after
 * the `approve` fallback, so a consent signed for an edited phrase never matches the server's own.
 */
export const consentHashOf = (planHash: string, phrase: string) =>
  sha256(canonical({ plan: planHash, phrase: effectivePhrase(phrase) }));

/**
 * The hash a consent binds: the `only` of its one root block, which must carry an `exp` too. A
 * consent comes straight from the principal, so a delegated block can't turn another grant (the
 * policy) into one. Null when the grant isn't shaped like a consent.
 */
function boundHash(blocks: { caveats: unknown[] }[] | null): string | null {
  const root = blocks?.length === 1 ? blocks[0] : null;
  const only = root?.caveats
    .map((c) => caveatOf(c, 'only'))
    .find((v) => v !== undefined);
  const exp = root?.caveats.some((c) => caveatOf(c, 'exp') !== undefined);

  return typeof only === 'string' && exp ? only : null;
}

/**
 * Whether a stored consent may run this plan (SPEC-approval §6): it must be a consent grant for
 * exactly this plan and `phrase`, the one the tool names now (`only` = their consent hash, and
 * `exp` present), signed by the pinned principal and issued to the server. A copied policy
 * grant isn't shaped like a consent. One that is valid but binds another hash is refused with
 * `OTHER_PHRASE`, so the caller can say why. `id` is what to consume it by.
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
  const bound = boundHash(await blocksOf(grant));

  if (bound === null) {
    return { ok: false, why: NOT_A_CONSENT };
  }

  // Checked against the hash it binds, so a valid consent for another phrase is told apart.
  const check = await checkGrant(grant, {
    service: o.policy.server,
    verb: 'COMMIT',
    capability: o.hp.tool,
    ...(o.now === undefined ? {} : { now: o.now }),
    proposal: { hash: bound, uses: o.hp.plan.uses, risk: o.hp.risk },
    trusted: [o.policy.principal],
    proofKey: o.policy.server,
  });

  if (!check.ok) {
    return { ok: false, why: check.reason };
  }

  return bound === (await consentHashOf(o.hp.planHash, o.phrase))
    ? { ok: true, id: check.id }
    : { ok: false, why: OTHER_PHRASE };
}
