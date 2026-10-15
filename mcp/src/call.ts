/**
 * The guarded callback: how a job call runs (SPEC-mcp-ts, "How a call runs"). The SDK's job call
 * session (`jobCall`) decides every round and owns the order that keeps it safe. This file and
 * its parts in call/ are its adapter: they read the request (who is calling, the policy, whether
 * the client can ask, the state and answer a retry carries) and turn the session's outcome into
 * an MCP result, running the chosen plan once (call/apply.ts).
 */
import {
  type JobCall,
  type JobCallOutcome,
  jobCall,
  printable,
} from '@yea-protocol/sdk';
import { runPlan } from './call/apply.js';
import { begin, type Call, type Result } from './call/context.js';
import { askResult, retryOf } from './call/round.js';
import { canAsk } from './client.js';
import { clarifyResult, consentResult, previewResult } from './render.js';
import { errorResult, NOTHING_RAN, refused } from './result.js';
import { errorMessage } from './util.js';

export { isPartial, PartialApplyError } from './call/apply.js';

export {
  callerOf,
  type JobDef,
  type RevertFn,
  type RevertInput,
  type Yea,
} from './call/context.js';

/** The session's facts for this round, read from the call. */
const factsOf = (call: Call, preview: boolean): JobCall => ({
  tool: call.job,
  input: call.input,
  plan: () => call.job.plan(call.input, call.ctx),
  preview,
  sub: call.sub,
  now: call.now,
  policy: call.policy,
  canAsk: canAsk(call.server, call.ctx),
  ...('why' in call.y.principal ? { unpinned: call.y.principal.why } : {}),
});

/** The guarded callback. Anything unexpected before `apply()` runs nothing. */
export async function runJob(
  base: Pick<Call, 'y' | 'server' | 'job' | 'input' | 'ctx'>,
  preview: boolean,
): Promise<Result> {
  try {
    const call = await begin(base);
    const retry = preview ? undefined : retryOf(call.ctx);
    const outcome = await jobCall(factsOf(call, preview), call.y.store, retry);

    return await resultOf(call, outcome);
  } catch (e) {
    return refused(printable(errorMessage(e)));
  }
}

/** The MCP result for a round's outcome. */
function resultOf(call: Call, o: JobCallOutcome): Promise<Result> | Result {
  switch (o.kind) {
    case 'clarify':
      return clarifyResult(o.clarification);
    case 'preview':
      return previewResult(o.plans, call.job.ownResultsAreErrors?.() ?? false);
    case 'run':
      return runPlan(call, o.plan, o.held, o.how);
    case 'ask':
      return askResult(call, o);
    case 'consent-codes':
      return consentResult(o.why, o.plans, o.codes, o.unavailable);
    case 'refuse':
      return o.again
        ? errorResult([
            `✗ ${o.why}; ${NOTHING_RAN}. Call the tool again to ask again.`,
          ])
        : refused(o.why);
  }
}
