/**
 * What a job call works with (SPEC-mcp-ts, "How a call runs", step 1): the approval context
 * `yea()` creates, the job as the callback runs it, and what each call reads afresh: who is
 * calling and the policy for the call.
 */
import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  RequestStateCodec,
  ServerContext,
} from '@modelcontextprotocol/server';
import {
  type ApprovalStore,
  type Clarification,
  type HashedPlan,
  type JobPlan,
  type Policy,
  type Risk,
  unixNow,
} from '@yea-protocol/sdk';
import { type Pinned, readPolicy, readTighteningFor } from '../policy.js';
import type { Obj } from '../util.js';

export type Result = CallToolResult | InputRequiredResult;

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
  principal: Pinned;
  policy: string | undefined;
  tighten: unknown;
  /** The home directory `policy.json` is read from on every call; resolved once by `yea()`. */
  home: string;
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
export interface Call {
  y: Yea;
  server: McpServer;
  job: JobDef;
  input: Obj;
  ctx: ServerContext;
  sub: string;
  now: number;
  policy: Policy;
}

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

/**
 * The policy for this call. (A `total` on a MemoryStore needs one process, which stdio is, and
 * which HTTP promises with `singleProcess: true` at start-up, so there's no per-call check.)
 */
async function policyFor(y: Yea): Promise<Policy> {
  const { broken, deny, outOfBand } = readTighteningFor(y.tighten, y.home);

  // A policy file that can't be read hides its deny list: refuse rather than guess.
  if (broken) {
    throw new Error(`your unsigned policy can't be used (${broken})`);
  }

  const pinned = 'key' in y.principal ? y.principal.key : null;
  // Without a pinned principal nothing auto-runs (SPEC-approval §2).
  const grant = pinned ? readPolicy(y.policy) : null;

  return {
    grant,
    principal: pinned ?? '',
    server: await y.serviceId(),
    deny,
    outOfBand,
  };
}

/** Step 1: who is calling, and the policy for this call. */
export async function begin(
  base: Pick<Call, 'y' | 'server' | 'job' | 'input' | 'ctx'>,
): Promise<Call> {
  const sub = callerOf(base.y, base.ctx);

  return {
    ...base,
    sub,
    now: unixNow(),
    policy: await policyFor(base.y),
  };
}
