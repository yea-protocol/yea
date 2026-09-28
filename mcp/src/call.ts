/**
 * The guarded callback: how a job call runs (SPEC-mcp-ts, "How a call runs", steps 1–11). Every
 * decision comes from the SDK core (`decide`, `buildForm`, `judgeAnswer`, `checkJobConsent`);
 * this file and its parts in call/ (the call's context, approval, and apply) only order them and
 * turn their answers into MCP results.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  type Clarification,
  decide,
  type HashedPlan,
  hashPlans,
  reserveAll,
} from '@yea-protocol/sdk';
import { runPlan } from './call/apply.js';
import { answer, ask, consented } from './call/approve.js';
import { begin, type Call, type Result } from './call/context.js';
import { clarifyResult, previewResult } from './render.js';
import { refused } from './result.js';
import { errorMessage, isObject } from './util.js';

/** Step 3: the plans, hashed; or what to return instead (a question, or no plans). */
async function planFor(
  call: Omit<Call, 'plans'>,
): Promise<{ plans: HashedPlan[] } | { result: CallToolResult }> {
  const out = await call.job.plan(call.input, call.ctx);

  if (isObject(out) && 'clarify' in out) {
    return { result: clarifyResult(out as Clarification) };
  }

  if (!Array.isArray(out)) {
    throw new TypeError('plan() must return an array of plans or clarify()');
  }

  if (!out.length) {
    return { result: refused(`${call.job.name} has no way to do this`) };
  }

  return { plans: await hashPlans(call.job, call.input, out) };
}

/** The guarded callback, steps 1–11. Anything unexpected before `apply()` runs nothing. */
export async function runJob(
  base: Pick<Call, 'y' | 'server' | 'job' | 'input' | 'ctx'>,
  preview: boolean,
): Promise<Result> {
  try {
    const started = await begin(base);

    // Step 2: a denied tool shows nothing, not even a preview.
    if (started.policy.deny.includes(base.job.name)) {
      return refused(`your policy never allows ${base.job.name}`);
    }

    const planned = await planFor(started);

    if ('result' in planned) {
      return planned.result;
    }

    const call = { ...started, plans: planned.plans };

    return preview
      ? previewResult(call.plans, call.job.ownResultsAreErrors?.() ?? false)
      : await route(call);
  } catch (e) {
    return refused(errorMessage(e));
  }
}

/** Step 5: a first call, or a retry carrying our state. Anything else is refused. */
function route(call: Call): Promise<Result> {
  const state: unknown = call.ctx.mcpReq.requestState();

  if (state === undefined) {
    return firstCall(call);
  }

  if (typeof state === 'string') {
    throw new Error(
      'requestState was not verified: pass approvals.serverOptions() to new McpServer',
    );
  }

  if (!isObject(state) || !Object.hasOwn(state, 'yea')) {
    throw new Error(
      "requestState belongs to something else, not this job's approval",
    );
  }

  return answer(call, state.yea);
}

/** Steps 6–8 on a first call: a consent, the policy, or ask. */
async function firstCall(call: Call): Promise<Result> {
  const approved = await consented(call);

  if (approved) {
    return runPlan(call, approved, [], 'approved');
  }

  const d = await decide(
    call.plans,
    call.policy,
    (k) => call.y.store.used(k),
    call.now,
  );

  switch (d.kind) {
    case 'run': {
      const held = await reserveAll(call.y.store, d.reserve);

      return held
        ? runPlan(call, d.plan, held, 'auto')
        : ask(call, 'a limit filled up while this call was being decided', 1);
    }
    case 'denied':
      return refused(d.why);
    case 'nothing':
      return refused('no plans');
    case 'ask':
    case 'out-of-band':
      return ask(call, d.why, 1);
  }
}
