/**
 * A round's plans (SPEC-approval §1): the handler's answer hashed, or what to return instead (its
 * question, or a refusal when it has no plans); and the phrase the person types for each plan.
 */
import { type HashedPlan, hashPlans } from '../approval.js';
import { checkedPhrase } from '../ask.js';
import type { Clarification } from '../plan.js';
import { isObject } from '../util.js';
import type { JobCall, JobCallOutcome } from './types.js';

/** A clarification: the handler's question back to the model, returned as it is. */
const isClarification = (v: unknown): v is Clarification =>
  isObject(v) && 'clarify' in v;

/** The handler's plans, hashed, or the outcome that ends the round before any plan is judged. */
export async function plansOf(
  call: JobCall,
): Promise<{ plans: HashedPlan[] } | { outcome: JobCallOutcome }> {
  const out: unknown = await call.plan();

  if (isClarification(out)) {
    return { outcome: { kind: 'clarify', clarification: out } };
  }

  if (!Array.isArray(out)) {
    throw new TypeError('plan() must return an array of plans or clarify()');
  }

  if (!out.length) {
    return {
      outcome: {
        kind: 'refuse',
        why: `${call.tool.name} has no way to do this`,
      },
    };
  }

  return { plans: await hashPlans(call.tool, call.input, out) };
}

/**
 * The phrase the person types for a plan: the tool's, or `approve`. One that isn't a string, or
 * isn't printable text (SPEC-approval §3), is the developer's error: the round throws before
 * anyone is asked.
 */
export function phraseOf(call: JobCall): (hp: HashedPlan) => string {
  const confirm = call.tool.confirmWith;

  return (hp) => {
    const phrase = confirm ? confirm(hp, call.input) : '';

    if (typeof phrase !== 'string') {
      throw new TypeError('confirmWith() must return a string');
    }

    return checkedPhrase(phrase, 'the phrase from confirmWith()');
  };
}
