/**
 * `job()`: register a tool that returns plans instead of acting (SPEC-mcp-ts
 * `approvals.job`). Its config, then the registration.
 */
import type {
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
import { jobAnnotations, jobMeta } from './result.js';
import { previewSchema, takePreview } from './schema.js';

export interface JobConfig<S extends StandardSchemaWithJSON> {
  title?: string;
  description?: string;
  annotations?: ToolAnnotations;
  inputSchema: S;
  /** The tool's default plan risk; a plan's own `risk` wins. Default `medium`. */
  risk?: Risk;
  /** `yea()`'s `requireInteraction`, for this tool alone. Default: `yea()`'s. */
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
      _meta: jobMeta(
        config.risk,
        config.revert !== undefined,
        config.requireInteraction ?? y.requireInteraction,
      ),
    },
    (args: unknown, ctx: ServerContext) => {
      const { input, preview } = takePreview(args);

      return runJob({ y, server, job: def, input, ctx }, preview);
    },
  );
}
