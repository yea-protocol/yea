/**
 * Approval for a job call (SPEC-mcp-ts, "How a call runs", steps 6–10): a consent from
 * `yea approve`, the form and its rounds, the answer judged, and consent codes when the client
 * can't ask.
 */
import {
  type CallToolResult,
  inputRequired,
  inputResponse,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  type ApprovalAnswer,
  type ApprovalState,
  buildForm,
  checkJobConsent,
  checkState,
  decodeGrant,
  type HashedPlan,
  inputHashOf,
  jobConsentCode,
  judgeAnswer,
  newState,
} from '@yea-protocol/sdk';
import { canAsk } from '../client.js';
import { consentResult } from '../render.js';
import { errorResult, NOTHING_RAN, refused } from '../result.js';
import { isObject } from '../util.js';
import { runPlan } from './apply.js';
import { type Call, phraseFor, type Result } from './context.js';

/** A retry whose approval state (ours, from `ask`) is invalid, expired or already consumed. */
const INVALID_APPROVAL = `this approval is invalid, expired, already used, or for another call; ${NOTHING_RAN}. Call the tool again to ask again.`;

const MEMORY_NO_CONSENT =
  "this server keeps approvals in memory, where `yea approve` can't reach them; use a client that can show approval forms, or run the server with a FileStore";

/** The expiry of a consent grant (its root `exp` caveat), to consume it until then. */
function consentExp(grant: string): number | null {
  const exp = decodeGrant(grant)[0]?.p.caveats.find(
    (c) => isObject(c) && Object.hasOwn(c, 'exp'),
  ) as { exp?: unknown } | undefined;

  return Number.isSafeInteger(exp?.exp) ? Number(exp?.exp) : null;
}

/** Step 6: the first plan with a valid, unused consent from `yea approve`, consumed. */
export async function consented(call: Call): Promise<HashedPlan | null> {
  if (!call.policy.principal) {
    return null;
  }

  for (const hp of call.plans) {
    const grant = await call.y.store.getConsent(hp.planHash);
    const check = grant
      ? await checkJobConsent(grant, { hp, policy: call.policy, now: call.now })
      : null;
    const exp = grant && check?.ok ? consentExp(grant) : null;

    if (
      check?.ok &&
      exp !== null &&
      (await call.y.store.consumeOnce(check.id, exp))
    ) {
      return hp;
    }
  }

  return null;
}

/** Step 8: a form if the client can take one, else step 9. */
export async function ask(
  call: Call,
  why: string,
  round: number,
): Promise<Result> {
  const form = canAsk(call.server, call.ctx)
    ? buildForm(call.plans, why, call.policy, phraseFor(call))
    : null;

  if (!form) {
    return failClosed(call, why, call.plans);
  }

  const state = newState({
    tool: call.job.name,
    inputHash: await inputHashOf(call.input),
    sub: call.sub,
    plans: form.offered,
    round,
    now: call.now,
  });

  return inputRequired({
    inputRequests: {
      yea: inputRequired.elicit({
        message: form.message,
        requestedSchema: form.requestedSchema as never,
      }),
    },
    requestState: await call.y.codec.mint({ yea: state }, call.ctx),
  });
}

/** Step 9: nothing runs; the plans and a consent code for each, for `yea approve`. */
async function failClosed(
  call: Call,
  why: string,
  plans: HashedPlan[],
): Promise<CallToolResult> {
  const allowed = plans.filter((hp) => !call.policy.deny.includes(hp.tool));
  const pinned = call.y.principal;

  if ('why' in pinned) {
    return consentResult(why, plans, [], pinned.why);
  }

  // `yea approve` stores consents in a FileStore; a code for a MemoryStore could never work.
  if (call.y.memoryStore) {
    return consentResult(why, plans, [], MEMORY_NO_CONSENT);
  }

  const phrase = phraseFor(call);
  const codes = allowed.map((hp) => ({
    planHash: hp.planHash,
    code: jobConsentCode({
      server: call.policy.server,
      principal: pinned.key,
      input: call.input,
      hp,
      phrase: phrase(hp),
      now: call.now,
    }),
  }));

  return consentResult(why, plans, codes, null);
}

/** The person's answer, as the core judges it; a missing one is not an approval. */
function answerOf(ctx: ServerContext): ApprovalAnswer {
  const view = inputResponse(ctx.mcpReq.inputResponses, 'yea');

  return view.kind === 'elicit'
    ? {
        action: view.action,
        ...(view.content ? { content: view.content } : {}),
      }
    : { action: 'decline' };
}

/** Step 10: check and consume the state, then judge the answer against the recomputed plans. */
export async function answer(call: Call, raw: unknown): Promise<Result> {
  const state: ApprovalState | null = checkState(raw, {
    tool: call.job.name,
    inputHash: await inputHashOf(call.input),
    sub: call.sub,
    now: call.now,
  });

  if (!state || !(await call.y.store.consumeOnce(state.nonce, state.exp))) {
    return errorResult([`✗ ${INVALID_APPROVAL}`]);
  }

  const v = judgeAnswer(state, answerOf(call.ctx), {
    recomputed: call.plans,
    policy: call.policy,
    phraseFor: phraseFor(call),
  });

  switch (v.kind) {
    case 'run':
      return runPlan(call, v.plan, [], 'approved');
    case 'ask-again':
      return ask(call, v.why, v.round);
    case 'out-of-band':
      return failClosed(
        call,
        `risk is ${v.plan.risk}, which needs approval outside the chat`,
        [v.plan],
      );
    case 'denied':
    case 'refuse':
      return refused(v.why);
    case 'not-approved':
      return refused('not approved');
  }
}
