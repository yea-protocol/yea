/**
 * The job call session (GLOSSARY.md "Job call"; docs/framework/SPEC-approval.md, "How a job call
 * runs"): one call of a job tool, from the plans its handler returns to an outcome. It owns the
 * order that makes the approval core's decisions safe:
 * - a denied tool is refused before its handler runs, so it shows nothing, not even a preview;
 * - a stored consent is consumed before its plan runs, and tried before the policy;
 * - totals are reserved after the policy decides, all or nothing;
 * - a returned state is checked and its nonce consumed before the answer is judged.
 *
 * It's a step function: each round of a call is one `jobCall`, given the store and, on a retry,
 * the state the last round handed out and the person's answer. The adapter (an MCP SDK) only
 * reads the request, carries the state round the client, and turns outcomes into results. Its
 * parts live in job-call/, private to this file.
 */
import { assertIntegers, deniedWhy } from './approval.js';
import { answerRound } from './job-call/answer.js';
import { firstRound } from './job-call/first.js';
import { phraseOf, plansOf } from './job-call/plans.js';
import type {
  JobCall,
  JobCallOutcome,
  JobCallRetry,
} from './job-call/types.js';
import type { ApprovalStore } from './store.js';

export type {
  ConsentCodes,
  ConsentCodesOutcome,
  JobCall,
  JobCallOutcome,
  JobCallRetry,
  JobTool,
} from './job-call/types.js';

/**
 * One round of a job call. A first round tries a stored consent, then the policy, then asks; a
 * retry judges the person's answer. It throws on a developer's error (a non-integer input, a
 * handler that returns neither plans nor a clarification, an untypeable phrase) and on a store
 * failure, before anything has run: the adapter refuses the call with the message.
 */
export async function jobCall(
  call: JobCall,
  store: ApprovalStore,
  retry?: JobCallRetry,
): Promise<JobCallOutcome> {
  assertIntegers(call.input);

  const denied = deniedWhy(call.tool.name, call.policy);

  if (denied) {
    return { kind: 'refuse', why: denied };
  }

  const planned = await plansOf(call);

  if ('outcome' in planned) {
    return planned.outcome;
  }

  if (call.preview) {
    return { kind: 'preview', plans: planned.plans };
  }

  const round = {
    call,
    plans: planned.plans,
    store,
    phraseFor: phraseOf(call),
  };

  return retry ? answerRound(round, retry) : firstRound(round);
}
