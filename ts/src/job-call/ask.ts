/**
 * Asking the person (SPEC-approval §3, §4, §6): the form and the state that goes round the client
 * when the client can take a form, and otherwise the plans with a consent code for each.
 */
import { type HashedPlan, ruledOut } from '../approval.js';
import { buildForm, inputHashOf, jobConsentCode, newState } from '../ask.js';
import { isMemoryStore } from '../store.js';
import type { ConsentCodesOutcome, JobCallOutcome, Round } from './types.js';

/** `yea approve` stores consents in a FileStore; a code for a MemoryStore could never work. */
const MEMORY_NO_CONSENT =
  "this server keeps approvals in memory, where `yea approve` can't reach them; use a client that can show approval forms, or run the server with a FileStore";

/** Ask with a form if the client can take one and a plan can be offered; else consent codes. */
export async function ask(
  r: Round,
  why: string,
  round: number,
): Promise<JobCallOutcome> {
  const { call } = r;
  const form = call.canAsk
    ? buildForm(r.plans, why, call.policy, r.phraseFor)
    : null;

  if (!form) {
    return consentCodes(r, why, r.plans);
  }

  const state = newState({
    tool: call.tool.name,
    inputHash: await inputHashOf(call.input),
    sub: call.sub,
    plans: form.offered,
    round,
    now: call.now,
  });

  return {
    kind: 'ask',
    form,
    state,
    otherwise: () => consentCodes(r, why, r.plans),
  };
}

/**
 * Why no consent counts without a pinned key, for the model to pass on: it names `yea doctor`,
 * which changes no keys, never a command that makes one (§6).
 */
const noPrincipal = (why?: string) =>
  `no principal key is pinned${why ? ` (${why})` : ''}: run \`yea doctor\` in a terminal outside this chat; it says how to pin one`;

/** Nothing runs: the plans, and a consent code for each one the policy doesn't deny (§6). */
export async function consentCodes(
  r: Round,
  why: string,
  plans: HashedPlan[],
): Promise<ConsentCodesOutcome> {
  const { call } = r;
  const base = { kind: 'consent-codes' as const, why, plans, codes: [] };

  if (!call.policy.principal) {
    return {
      ...base,
      unavailable: noPrincipal(call.unpinned),
    };
  }

  if (isMemoryStore(r.store)) {
    return { ...base, unavailable: MEMORY_NO_CONSENT };
  }

  const codes = await Promise.all(
    plans
      .filter((hp) => ruledOut(hp, call.policy)?.kind !== 'denied')
      .map(async (hp) => ({
        planHash: hp.planHash,
        code: await jobConsentCode({
          server: call.policy.server,
          principal: call.policy.principal,
          input: call.input,
          hp,
          phrase: r.phraseFor(hp),
          now: call.now,
        }),
      })),
  );

  return { ...base, codes, unavailable: null };
}
