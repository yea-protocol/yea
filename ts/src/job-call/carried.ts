/**
 * A consent on the call (SPEC-approval §6): the one `yea approve` printed, passed back as
 * `yea_consent`. It's checked and consumed exactly as a stored consent, so it runs at most once
 * whichever way it arrived. One that approves no plan runs nothing: the call asks again and says
 * why, and never falls through to a stored consent or the policy.
 */
import {
  checkJobConsent,
  type HashedPlan,
  jobConsentExpiry,
  NOT_A_CONSENT,
  OTHER_PHRASE,
  stripPhraseEdge,
} from '../approval.js';
import { ask } from './ask.js';
import type { JobCallOutcome, Round } from './types.js';

/** Why a consent on the call ran nothing: fixed text, so both languages say the same (§6). */
const WHY = {
  notConsent: "it isn't a consent from yea approve",
  expired: 'it has expired',
  notSigned:
    "it isn't signed by the pinned principal for this tool at this server",
  noPlan:
    'it approves none of these plans; if the person approved this exact request, this server may have restarted since or not be the one that asked, or the code they were given may have been altered',
  used: 'it was already used',
} as const;

/** Why the grant check refused a consent: expired, or anything else it could be. */
async function refusedWhy(token: string, why: string, now: number) {
  if (why === NOT_A_CONSENT) {
    return WHY.notConsent;
  }

  const exp = await jobConsentExpiry(token);

  return exp !== null && exp <= now ? WHY.expired : WHY.notSigned;
}

/** The plan a consent on the call runs, consumed by its grant id; or why it runs none. */
async function approvedBy(
  r: Round,
  token: string,
): Promise<{ plan: HashedPlan } | { why: string }> {
  const { policy, now, unpinned } = r.call;

  if (!policy.principal) {
    return { why: unpinned ?? 'no principal key is pinned' };
  }

  for (const hp of r.plans) {
    const check = await checkJobConsent(token, {
      hp,
      phrase: r.phraseFor(hp),
      store: r.storeId,
      policy,
      now,
    });

    if (check.ok) {
      return (await r.store.consumeOnce(check.id, check.exp))
        ? { plan: hp }
        : { why: WHY.used };
    }

    // Only the hash it binds differs from plan to plan; any other refusal is the same for all.
    // So reaching the end means it binds none of them: another plan, phrase or store, or an
    // edited code, which the person may want to know about (§6).
    if (check.why !== OTHER_PHRASE) {
      return { why: await refusedWhy(token, check.why, now) };
    }
  }

  return { why: WHY.noPlan };
}

/**
 * A first round that carries a consent: it runs the plan it approves, or the call asks again.
 * The edge set a typed phrase loses (§3) is stripped first, so the newline a terminal copy adds
 * doesn't matter: the signature covers nothing outside the `pg1.` token.
 */
export async function carriedRound(
  r: Round,
  token: string,
): Promise<JobCallOutcome> {
  const approved = await approvedBy(r, stripPhraseEdge(token));

  return 'plan' in approved
    ? { kind: 'run', plan: approved.plan, held: [], how: 'approved' }
    : ask(
        r,
        `the consent passed as yea_consent can't be used: ${approved.why}`,
        1,
      );
}
