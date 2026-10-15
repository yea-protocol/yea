/**
 * A retry with the person's answer (SPEC-approval §5): the state checked and its nonce consumed,
 * whatever the answer, before the answer is judged against the plans recomputed this round.
 */
import { outOfBandWhy } from '../approval.js';
import { checkState, inputHashOf, judgeAnswer } from '../ask.js';
import { ask, consentCodes } from './ask.js';
import type { JobCallOutcome, JobCallRetry, Round } from './types.js';

/** One message for every reason a state can't be used (§5 step 1). */
const INVALID_STATE =
  'this approval is invalid, expired, already used, or for another call';

/** Check and consume the state, then judge the answer against the recomputed plans. */
export async function answerRound(
  r: Round,
  retry: JobCallRetry,
): Promise<JobCallOutcome> {
  const { call } = r;
  const state = checkState(retry.state, {
    tool: call.tool.name,
    inputHash: await inputHashOf(call.input),
    sub: call.sub,
    now: call.now,
  });

  if (!state || !(await r.store.consumeOnce(state.nonce, state.exp))) {
    return { kind: 'refuse', why: INVALID_STATE, again: true };
  }

  const v = judgeAnswer(state, retry.answer, {
    recomputed: r.plans,
    policy: call.policy,
    phraseFor: r.phraseFor,
  });

  switch (v.kind) {
    case 'run':
      return { kind: 'run', plan: v.plan, held: [], how: 'approved' };
    case 'ask-again':
      return ask(r, v.why, v.round);
    case 'out-of-band':
      return consentCodes(r, outOfBandWhy(v.plan), [v.plan]);
    case 'denied':
    case 'refuse':
      return { kind: 'refuse', why: v.why };
    case 'not-approved':
      return { kind: 'refuse', why: 'not approved' };
  }
}
