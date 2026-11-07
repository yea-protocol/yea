/**
 * `job()`: register a tool that returns plans instead of acting (SPEC-mcp-ts
 * `approvals.job`). Its config and the rules that close it, then the registration.
 */
import type {
  Icon,
  McpServer,
  RegisteredTool,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import type {
  Clarification,
  HashedPlan,
  JobPlan,
  Risk,
} from '@yea-protocol/sdk';
import { type JobDef, type RevertFn, runJob, type Yea } from './call.js';
import {
  aBoolean,
  aFunction,
  anObject,
  aRisk,
  aString,
  nested,
  type Rule,
  refused,
  required,
} from './options.js';
import { jobAnnotations, jobMeta } from './result.js';
import { previewSchema, takePreview } from './schema.js';
import { isObject, type Obj } from './util.js';

export interface JobConfig<S extends StandardSchemaWithJSON> {
  title?: string;
  description?: string;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  /** The tool's own `_meta`; YEA's keys are merged over it, and win. */
  _meta?: Record<string, unknown>;
  inputSchema: S;
  /** The tool's default plan risk; a plan's own `risk` wins. Default `medium`. */
  risk?: Risk;
  /**
   * `yea()`'s `requireInteraction`, for this tool alone. Default: `yea()`'s. On, it also marks this
   * server's `undo`: undoing acts too.
   */
  requireInteraction?: boolean;
  /** Must not change anything: it runs on preview, on every retry, and under the legacy shim. */
  plan(
    input: StandardSchemaWithJSON.InferOutput<S>,
    ctx: ServerContext,
  ): JobPlan[] | Clarification | Promise<JobPlan[] | Clarification>;
  revert?(
    r: {
      input: StandardSchemaWithJSON.InferOutput<S>;
      planHash: string;
      result: unknown;
    },
    ctx: ServerContext,
  ): unknown;
  /** The phrase the person types; `approve` if absent or empty. */
  confirmWith?(
    plan: HashedPlan,
    input: StandardSchemaWithJSON.InferOutput<S>,
  ): string;
}

/** A Standard Schema: an object, or a function as ArkType's types are, with a `~standard` object. */
const isStandardSchema = (v: unknown) =>
  (typeof v === 'object' || typeof v === 'function') &&
  v !== null &&
  isObject((v as Obj)['~standard']);

/** `registerTool`'s annotations, each of its type. */
const ANNOTATIONS = {
  title: aString,
  readOnlyHint: aBoolean,
  destructiveHint: aBoolean,
  idempotentHint: aBoolean,
  openWorldHint: aBoolean,
} satisfies Record<keyof ToolAnnotations, Rule>;

/**
 * One rule per key of `JobConfig` (SPEC-mcp-ts, "Closed options"). `outputSchema` is refused:
 * what a job returns is YEA's, so a schema for the tool's own results would never hold.
 */
export const JOB_CONFIG = {
  title: aString,
  description: aString,
  annotations: nested(ANNOTATIONS),
  icons: {
    is: 'an array of icons, each with a string src',
    ok: (v) =>
      Array.isArray(v) &&
      v.every((i) => isObject(i) && typeof i.src === 'string'),
  },
  _meta: anObject,
  inputSchema: required({ is: 'a Standard Schema', ok: isStandardSchema }),
  risk: aRisk,
  requireInteraction: aBoolean,
  plan: required(aFunction),
  revert: aFunction,
  confirmWith: aFunction,
  outputSchema: refused(
    "a job's results are YEA's (plans, receipts and refusals), not the tool's",
  ),
} satisfies Record<
  keyof JobConfig<StandardSchemaWithJSON> | 'outputSchema',
  Rule
>;

/** Register `name` on `server` as a job tool (SPEC-mcp-ts `approvals.job`). */
export function registerJob<S extends StandardSchemaWithJSON>(
  y: Yea,
  server: McpServer,
  name: string,
  config: JobConfig<S>,
): RegisteredTool {
  const schema = previewSchema(config.inputSchema);
  const def: JobDef = {
    name,
    risk: config.risk,
    plan: async (input, ctx) =>
      config.plan(input as StandardSchemaWithJSON.InferOutput<S>, ctx),
    revert: config.revert as RevertFn | undefined,
    confirmWith: config.confirmWith as JobDef['confirmWith'],
    guarded: false,
  };

  return server.registerTool(
    name,
    {
      ...(config.title === undefined ? {} : { title: config.title }),
      ...(config.description === undefined
        ? {}
        : { description: config.description }),
      inputSchema: schema,
      annotations: jobAnnotations(config.annotations),
      ...(config.icons === undefined ? {} : { icons: config.icons }),
      _meta: {
        ...config._meta,
        ...jobMeta(
          config.risk,
          config.revert !== undefined,
          config.requireInteraction ?? y.requireInteraction,
        ),
      },
    },
    (args: unknown, ctx: ServerContext) => {
      const { input, preview } = takePreview(args);

      return runJob({ y, server, job: def, input, ctx }, preview);
    },
  );
}
