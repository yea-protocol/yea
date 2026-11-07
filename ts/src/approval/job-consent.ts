/**
 * Consents for one plan (SPEC-approval §6): the consent hash that binds a plan to its phrase and
 * the store that consumes it, and checking a consent grant against the one plan it approves.
 */
import { canonical } from '../canonical.js';
import { sha256 } from '../crypto.js';
import { checkGrant } from '../grants.js';
import { blocksOf, caveatOf } from './grant-blocks.js';
import { effectivePhrase } from './phrase-form.js';
import type { HashedPlan } from './plans.js';
import type { Policy } from './policy.js';

/** Why a stored consent is refused when it isn't shaped like one (§6). */
export const NOT_A_CONSENT = 'not a consent for this plan';

/**
 * Why a consent is refused when the principal signed it, validly, for another hash: the tool's
 * phrase changed, the code the person approved was edited, or it binds another store (§6).
 */
export const OTHER_PHRASE = 'not a consent for this phrase';

/**
 * What a consent grant's `only` binds (§6): the plan, the phrase the tool names for it (after the
 * `approve` fallback) and the id of the store that consumes it. So a consent signed for an edited
 * phrase never matches the server's own, and one consumed in a store never runs in another.
 */
export const consentHashOf = (
  planHash: string,
  phrase: string,
  store: string,
) =>
  sha256(canonical({ plan: planHash, phrase: effectivePhrase(phrase), store }));

/** The earliest integer `exp` among `caveats`, or null if there's none. */
function earliestExp(caveats: unknown[]): number | null {
  const exps = caveats
    .map((c) => caveatOf(c, 'exp'))
    .filter((v): v is number => Number.isSafeInteger(v));

  return exps.length ? Math.min(...exps) : null;
}

/**
 * What a consent binds and until when: the `only` of its one root block, which must carry an
 * `exp` too. A consent comes straight from the principal, so a delegated block can't turn
 * another grant (the policy) into one. Null when the grant isn't shaped like a consent.
 */
function consentShape(
  blocks: { caveats: unknown[] }[] | null,
): { only: string; exp: number } | null {
  const root = blocks?.length === 1 ? blocks[0] : null;
  const only = root?.caveats
    .map((c) => caveatOf(c, 'only'))
    .find((v) => v !== undefined);
  const exp = root ? earliestExp(root.caveats) : null;

  return typeof only === 'string' && exp !== null ? { only, exp } : null;
}

/**
 * When a consent grant expires: its earliest `exp`, read without checking anything else, or
 * null if it isn't shaped like a consent. To tell an expired consent from a forged one when the
 * grant check fails (§6).
 */
export async function consentExpiry(grant: string): Promise<number | null> {
  return consentShape(await blocksOf(grant))?.exp ?? null;
}

/**
 * Whether a consent, from the store or on the call, may run this plan (SPEC-approval §6): it
 * must be a consent grant for exactly this plan and `phrase`, the one the tool names now, in the
 * store whose id is `store` (`only` = their consent hash, and `exp` present), signed by the
 * pinned principal and issued to the server. A copied policy grant isn't shaped like a consent. One that is valid but binds
 * another hash is refused with `OTHER_PHRASE`, so the caller can say why. `id` is what to
 * consume it by, until `exp`.
 */
export async function checkJobConsent(
  grant: string,
  o: {
    hp: HashedPlan;
    phrase: string;
    store: string;
    policy: Pick<Policy, 'principal' | 'server'>;
    now?: number;
  },
): Promise<{ ok: true; id: string; exp: number } | { ok: false; why: string }> {
  const shape = consentShape(await blocksOf(grant));

  if (shape === null) {
    return { ok: false, why: NOT_A_CONSENT };
  }

  const bound = shape.only;

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

  return bound === (await consentHashOf(o.hp.planHash, o.phrase, o.store))
    ? { ok: true, id: check.id, exp: shape.exp }
    : { ok: false, why: OTHER_PHRASE };
}
