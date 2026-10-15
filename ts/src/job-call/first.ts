/**
 * A job call's first round (SPEC-approval §2, §5, §6): a consent from `yea approve`, consumed;
 * else the policy decision, reserving after deciding; else ask.
 */
import {
  checkJobConsent,
  decide,
  type HashedPlan,
  reserveAll,
} from '../approval.js';
import { decodeGrant } from '../grants.js';
import { isObject } from '../util.js';
import { ask } from './ask.js';
import type { JobCallOutcome, Round } from './types.js';

/** The expiry of a consent grant (its root `exp` caveat), to consume it until then. */
function consentExp(grant: string): number | null {
  const exp = decodeGrant(grant)[0]?.p.caveats.find(
    (c) => isObject(c) && Object.hasOwn(c, 'exp'),
  ) as { exp?: unknown } | undefined;

  return Number.isSafeInteger(exp?.exp) ? Number(exp?.exp) : null;
}

/**
 * The first plan with a valid, unused consent from `yea approve`, consumed by its grant id. One
 * that is consumed, expired or failing counts as absent (§6).
 */
async function consented(r: Round): Promise<HashedPlan | null> {
  const { policy, now } = r.call;

  if (!policy.principal) {
    return null;
  }

  for (const hp of r.plans) {
    const grant = await r.store.getConsent(hp.planHash);
    const check = grant
      ? await checkJobConsent(grant, { hp, policy, now })
      : null;
    const exp = grant && check?.ok ? consentExp(grant) : null;

    if (
      check?.ok &&
      exp !== null &&
      (await r.store.consumeOnce(check.id, exp))
    ) {
      return hp;
    }
  }

  return null;
}

/** A first round: a stored consent runs its plan; else the policy decides; else ask. */
export async function firstRound(r: Round): Promise<JobCallOutcome> {
  const approved = await consented(r);

  if (approved) {
    return { kind: 'run', plan: approved, held: [], how: 'approved' };
  }

  const { policy, now } = r.call;
  const d = await decide(r.plans, policy, (k) => r.store.used(k), now);

  switch (d.kind) {
    case 'run': {
      // Reserved after deciding, all or nothing: a limit another call filled since asks instead.
      const held = await reserveAll(r.store, d.reserve);

      return held
        ? { kind: 'run', plan: d.plan, held, how: 'auto' }
        : ask(r, 'a limit filled up while this call was being decided', 1);
    }
    case 'denied':
      return { kind: 'refuse', why: d.why };
    case 'nothing':
      return { kind: 'refuse', why: 'no plans' };
    case 'ask':
    case 'out-of-band':
      return ask(r, d.why, 1);
  }
}
