/**
 * A job call's first round (SPEC-approval §2, §5, §6): a consent on the call, which alone
 * decides; else a consent from `yea approve` in the store, consumed; else the policy decision,
 * reserving after deciding; else ask.
 */
import {
  checkJobConsent,
  decide,
  type HashedPlan,
  OTHER_PHRASE,
  reserveAll,
} from '../approval.js';
import { ask } from './ask.js';
import { carriedRound } from './carried.js';
import type { JobCallOutcome, Round } from './types.js';

/**
 * What the person is told when a stored consent was signed, validly, for a different phrase (§6):
 * the tool's phrase changed, or the code they approved was edited.
 */
const PHRASE_CHANGED =
  'a consent for this plan was signed for a different phrase; approve the new code — if this repeats, the code you were given may have been altered';

/**
 * A plan's stored consent, checked against the phrase the tool names now and this store's id;
 * null if none.
 */
async function storedConsent(r: Round, hp: HashedPlan) {
  const { policy, now } = r.call;
  const grant = await r.store.getConsent(hp.planHash);

  return grant
    ? checkJobConsent(grant, {
        hp,
        phrase: r.phraseFor(hp),
        store: r.storeId,
        policy,
        now,
      })
    : null;
}

/**
 * The first plan with a valid, unused consent from `yea approve`, consumed by its grant id. One
 * that is consumed, expired or failing counts as absent (§6), but one signed for a different
 * phrase leaves a note for the person, so a changed phrase or an edited code isn't silent.
 */
async function consented(
  r: Round,
): Promise<{ plan: HashedPlan | null; note: string | null }> {
  let note: string | null = null;

  if (!r.call.policy.principal) {
    return { plan: null, note };
  }

  for (const hp of r.plans) {
    const check = await storedConsent(r, hp);

    if (check?.ok && (await r.store.consumeOnce(check.id, check.exp))) {
      return { plan: hp, note: null };
    }

    if (check && !check.ok && check.why === OTHER_PHRASE) {
      note ??= PHRASE_CHANGED;
    }
  }

  return { plan: null, note };
}

/**
 * A first round: a consent on the call runs its plan or asks again; else a stored consent runs
 * its plan; else the policy decides; else ask.
 */
export async function firstRound(r: Round): Promise<JobCallOutcome> {
  if (r.call.consent !== undefined) {
    return carriedRound(r, r.call.consent);
  }

  const { plan: approved, note } = await consented(r);

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
      return ask(r, note ?? d.why, 1);
  }
}
