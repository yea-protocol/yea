/**
 * Judging the person's answer (docs/framework/SPEC-approval.md §5 steps 3–7;
 * the caller has checked the state and consumed its nonce).
 */
import type { HashedPlan, Policy } from '../approval.js';
import { atLeast } from '../risk.js';
import { type PhraseFor, phraseMatches, withFallback } from './phrase.js';
import { type ApprovalState, MAX_ROUNDS } from './state.js';

export interface ApprovalAnswer {
  action: 'accept' | 'decline' | 'cancel';
  content?: { plan?: unknown; confirm?: unknown };
}

export type Verdict =
  | { kind: 'refuse'; why: string }
  | { kind: 'not-approved' }
  | { kind: 'ask-again'; why: string; round: number }
  | { kind: 'denied'; why: string }
  | { kind: 'out-of-band'; plan: HashedPlan }
  | { kind: 'run'; plan: HashedPlan };

/** Ask again, unless that would pass the last round. */
function again(state: ApprovalState, why: string): Verdict {
  const round = state.round + 1;

  return round > MAX_ROUNDS
    ? { kind: 'refuse', why: `not approved after ${MAX_ROUNDS} tries` }
    : { kind: 'ask-again', why, round };
}

function chosenHash(state: ApprovalState, a: ApprovalAnswer): string | null {
  const plan = a.content?.plan;

  if (typeof plan === 'string') {
    return state.plans.includes(plan) ? plan : null;
  }

  return state.plans.length === 1 ? state.plans[0] : null;
}

/** What the plans, policy and phrases look like now, on the retry. */
export interface JudgeContext {
  recomputed: HashedPlan[];
  policy: Pick<Policy, 'outOfBand' | 'deny'>;
  phraseFor: PhraseFor;
}

export function judgeAnswer(
  state: ApprovalState,
  answer: ApprovalAnswer,
  { recomputed, policy, phraseFor }: JudgeContext,
): Verdict {
  const phrase = withFallback(phraseFor);

  if (answer.action !== 'accept') {
    return { kind: 'not-approved' };
  }

  const hash = chosenHash(state, answer);

  if (!hash) {
    return { kind: 'refuse', why: 'that plan was not offered' };
  }

  const hp = recomputed.find((p) => p.planHash === hash);

  if (!hp) {
    return again(state, 'the plans changed; choose again');
  }

  if (policy.deny.includes(hp.tool)) {
    return { kind: 'denied', why: `your policy never allows ${hp.tool}` };
  }

  if (atLeast(hp.risk, policy.outOfBand)) {
    return { kind: 'out-of-band', plan: hp };
  }

  return phraseMatches(answer.content?.confirm, phrase(hp))
    ? { kind: 'run', plan: hp }
    : again(state, `type "${phrase(hp)}" exactly to approve`);
}
