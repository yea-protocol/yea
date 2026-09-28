/**
 * The guarded callback: how a job call runs (SPEC-mcp-ts, "How a call runs", steps 1–11). Every
 * decision comes from the SDK core (`decide`, `buildForm`, `judgeAnswer`, `checkJobConsent`);
 * this file only orders them and turns their answers into MCP results.
 */
import {
  type CallToolResult,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  isInputRequiredResult,
  type McpServer,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  type ApprovalAnswer,
  type ApprovalState,
  type ApprovalStore,
  assertIntegers,
  buildForm,
  type Clarification,
  checkJobConsent,
  checkState,
  decide,
  decodeGrant,
  type HashedPlan,
  hashPlans,
  inputHashOf,
  type JobPlan,
  type JobReceipt,
  jobConsentCode,
  judgeAnswer,
  newReceiptId,
  newState,
  type Policy,
  type Reservation,
  type Risk,
  reserveAll,
} from '@yea-protocol/sdk';
import { canAsk } from './client.js';
import { type Pinned, readPolicy, readTighteningFor } from './keys.js';
import {
  clarifyResult,
  consentResult,
  errorResult,
  previewResult,
  receiptResult,
} from './render.js';

type Obj = Record<string, unknown>;
type Result = CallToolResult | InputRequiredResult;

/** What `revert` gets from the receipt, so any process can undo the job. */
export interface RevertInput {
  input: unknown;
  planHash: string;
  result: unknown;
}

export type RevertFn = (r: RevertInput, ctx: ServerContext) => unknown;

/** The one approval context per process that `yea()` creates. */
export interface Yea {
  transport: 'stdio' | 'http';
  store: ApprovalStore;
  /** A MemoryStore without a promise that one process serves every request. */
  sharedMemory: boolean;
  principal: Pinned;
  policy: string | undefined;
  tighten: unknown;
  codec: RequestStateCodec<unknown>;
  sub(ctx: ServerContext): string;
  serviceId(): Promise<string>;
}

/** A job as the callback runs it: from `job()` or from `guard()`. */
export interface JobDef {
  name: string;
  risk?: Risk;
  plan(input: Obj, ctx: ServerContext): Promise<JobPlan[] | Clarification>;
  revert?: RevertFn;
  confirmWith?(hp: HashedPlan, input: Obj): string;
  /** `guard`: an original result that is an error or asks for input counts as a failure. */
  guarded: boolean;
  /**
   * `guard` on a tool with an `outputSchema`: clients reject a success result whose
   * `structuredContent` doesn't match it, so the plugin's own results (the preview too) are
   * `isError`. Only the original callback's result is returned as a success.
   */
  ownResultsAreErrors?(): boolean;
}

/** Everything one call works with, read afresh on every call. */
interface Call {
  y: Yea;
  server: McpServer;
  job: JobDef;
  input: Obj;
  ctx: ServerContext;
  sub: string;
  now: number;
  policy: Policy;
  plans: HashedPlan[];
}

const NOTHING_RAN = 'nothing was run';
const BAD_STATE =
  'this approval is invalid, expired, already used, or for another call; nothing was run. Call the tool again to ask again.';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const isObject = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Who is calling; on HTTP an empty answer refuses the call (SPEC-mcp-ts, per-call refusals). */
export function callerOf(y: Yea, ctx: ServerContext): string {
  const sub = y.sub(ctx);

  if (typeof sub !== 'string' || (y.transport === 'http' && sub === '')) {
    throw new Error(
      "no authenticated caller: the server's sub() returned no identity",
    );
  }

  return sub;
}

/** Whether a policy grant has a `total` limit (a MemoryStore shared by processes can't hold one). */
function hasTotal(grant: string): boolean {
  try {
    return decodeGrant(grant).some((b) =>
      b.p.caveats.some((c) => isObject(c) && Object.hasOwn(c, 'total')),
    );
  } catch {
    return false; // the grant check says why it's unusable
  }
}

/** The policy for this call; throws when its totals can't be kept on this store. */
async function policyFor(y: Yea): Promise<Policy> {
  const rules = readTighteningFor(y.tighten);
  const pinned = 'key' in y.principal ? y.principal.key : null;
  // Without a pinned principal nothing auto-runs (SPEC-approval §2).
  const grant = pinned ? readPolicy(y.policy) : null;

  if (grant && y.sharedMemory && hasTotal(grant)) {
    throw new Error(
      'the policy has a total limit, which a MemoryStore can only keep when one process serves every request (singleProcess: true)',
    );
  }

  return {
    grant,
    principal: pinned ?? '',
    server: await y.serviceId(),
    ...rules,
  };
}

/** Step 1: who is calling, integer-only input, and the policy for this call. */
async function begin(
  base: Pick<Call, 'y' | 'server' | 'job' | 'input' | 'ctx'>,
): Promise<Omit<Call, 'plans'>> {
  const sub = callerOf(base.y, base.ctx);

  assertIntegers(base.input);

  return {
    ...base,
    sub,
    now: Math.floor(Date.now() / 1000),
    policy: await policyFor(base.y),
  };
}

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
    return {
      result: errorResult([
        `✗ ${call.job.name} has no way to do this; ${NOTHING_RAN}`,
      ]),
    };
  }

  return { plans: await hashPlans(call.job, call.input, out) };
}

/** The phrase the person types for a plan: the tool's, or `approve`. */
function phraseFor(call: Call): (hp: HashedPlan) => string {
  const confirm = call.job.confirmWith;

  return (hp) => {
    const phrase = confirm ? confirm(hp, call.input) : '';

    if (typeof phrase !== 'string') {
      throw new TypeError('confirmWith() must return a string');
    }

    return phrase;
  };
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
      return errorResult([
        `✗ your policy never allows ${base.job.name}; ${NOTHING_RAN}`,
      ]);
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
    return errorResult([`✗ ${message(e)}; ${NOTHING_RAN}`]);
  }
}

/** Step 5: a first call, or a retry carrying our state. Anything else is refused. */
function route(call: Call): Promise<Result> {
  const state: unknown = call.ctx.mcpReq.requestState();

  if (state === undefined) {
    return fresh(call);
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

/** The expiry of a consent grant (its root `exp` caveat), to consume it until then. */
function consentExp(grant: string): number | null {
  const exp = decodeGrant(grant)[0]?.p.caveats.find(
    (c) => isObject(c) && Object.hasOwn(c, 'exp'),
  ) as { exp?: unknown } | undefined;

  return Number.isSafeInteger(exp?.exp) ? Number(exp?.exp) : null;
}

/** Step 6: the first plan with a valid, unused consent from `yea approve`, consumed. */
async function consented(call: Call): Promise<HashedPlan | null> {
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

/** Steps 6–8 on a first call: a consent, the policy, or ask. */
async function fresh(call: Call): Promise<Result> {
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
      return errorResult([`✗ ${d.why}; ${NOTHING_RAN}`]);
    case 'nothing':
      return errorResult([`✗ no plans; ${NOTHING_RAN}`]);
    case 'ask':
    case 'out-of-band':
      return ask(call, d.why, 1);
  }
}

/** Step 8: a form if the client can take one, else step 9. */
async function ask(call: Call, why: string, round: number): Promise<Result> {
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
async function answer(call: Call, raw: unknown): Promise<Result> {
  const state: ApprovalState | null = checkState(raw, {
    tool: call.job.name,
    inputHash: await inputHashOf(call.input),
    sub: call.sub,
    now: call.now,
  });

  if (!state || !(await call.y.store.consumeOnce(state.nonce, state.exp))) {
    return errorResult([`✗ ${BAD_STATE}`]);
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
      return errorResult([`✗ ${v.why}; ${NOTHING_RAN}`]);
    case 'not-approved':
      return errorResult([`✗ not approved; ${NOTHING_RAN}`]);
  }
}

/** A guarded tool's own error, or a request for input, is a failed apply. */
const failedResult = (job: JobDef, result: unknown) =>
  job.guarded &&
  (!isObject(result) ||
    result.isError === true ||
    isInputRequiredResult(result));

/** Release reservations; one that can't be released stays held, which only over-counts. */
const releaseAll = (y: Yea, held: Reservation[]) =>
  Promise.allSettled(held.map((r) => y.store.release(r)));

/** Step 11: apply once, then settle and record the receipt. */
async function runPlan(
  call: Call,
  hp: HashedPlan,
  held: Reservation[],
  how: 'auto' | 'approved',
): Promise<Result> {
  let result: unknown;

  try {
    result = await hp.plan.apply();
  } catch (e) {
    await releaseAll(call.y, held);

    return errorResult([
      `✗ ${how === 'approved' ? 'approved, but ' : ''}${hp.plan.summary} failed: ${message(e)}; nothing changed.${how === 'approved' ? ' The approval is used up: calling again asks again.' : ''}`,
    ]);
  }

  if (failedResult(call.job, result)) {
    await releaseAll(call.y, held);

    return result as Result;
  }

  return recorded(call, hp, held, { result, auto: how === 'auto' });
}

/** The receipt a successful job leaves (SPEC-approval §8's JobReceipt). */
function receiptFor(call: Call, hp: HashedPlan, result: unknown): JobReceipt {
  const p = hp.plan;

  return {
    id: newReceiptId(),
    service: call.policy.server,
    proposal: hp.planHash,
    capability: hp.tool,
    summary: p.summary,
    at: call.now,
    effects: p.effects,
    ...(p.uses && Object.keys(p.uses).length ? { uses: p.uses } : {}),
    undo:
      hp.undoable && p.undoWindow !== undefined
        ? { until: call.now + p.undoWindow }
        : null,
    tool: hp.tool,
    input: call.input,
    planHash: hp.planHash,
    sub: call.sub,
    ...(result === undefined ? {} : { result }),
  };
}

/** After `apply()` succeeded: settle, store the receipt, and return it. */
async function recorded(
  call: Call,
  hp: HashedPlan,
  held: Reservation[],
  done: { result: unknown; auto: boolean },
): Promise<Result> {
  const receipt = receiptFor(call, hp, done.result);

  try {
    await Promise.all(held.map((r) => call.y.store.settle(r)));
    await call.y.store.putReceipt(receipt);
  } catch (e) {
    return unrecorded(call, hp, done.result, message(e));
  }

  if (call.job.guarded) {
    const r = done.result as CallToolResult;

    return { ...r, _meta: { ...r._meta, 'dev.yea/receipt': receipt } };
  }

  return receiptResult(receipt, done.auto);
}

/** The action happened, but its receipt couldn't be kept: say so, and that undo isn't available. */
function unrecorded(
  call: Call,
  hp: HashedPlan,
  result: unknown,
  why: string,
): Result {
  const note = `✓ ${hp.plan.summary} happened, but its receipt couldn't be saved (${why}), so it can't be undone.`;

  if (call.job.guarded) {
    const r = result as CallToolResult;

    return {
      ...r,
      content: [...(r.content ?? []), { type: 'text', text: note }],
    };
  }

  return {
    content: [{ type: 'text', text: note }],
    structuredContent: { receipt: null, result: result ?? null },
  };
}
