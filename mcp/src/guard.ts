/**
 * `guard()`: turn a tool already registered into a job, by replacing its handler through
 * `RegisteredTool.update` (SPEC-mcp-ts `guard`). Its config and the rules that close it, then
 * the replacement.
 */
import type {
  McpServer,
  RegisteredTool,
  ServerContext,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import type { Effect, HashedPlan, Risk, Uses } from '@yea-protocol/sdk';
import { type JobDef, type RevertFn, runJob, type Yea } from './call.js';
import { aBoolean, aFunction, aRisk, type Rule, required } from './options.js';
import { jobAnnotations, jobMeta } from './result.js';
import {
  jobInputSchema,
  NO_INPUT,
  type Reserved,
  takeReserved,
} from './schema.js';
import { errorMessage, registryOf } from './util.js';

/** What a guarded tool's `describe(input)` returns: a plan without `apply`. */
export interface Described {
  summary: string;
  effects: Effect[];
  uses?: Uses;
  risk?: Risk;
  undoWindow?: number;
}

export interface GuardConfig {
  describe(input: Record<string, unknown>): Described | Promise<Described>;
  /** The tool's default plan risk, and its `_meta` risk; `describe`'s own `risk` wins. Default `medium`. */
  risk?: Risk;
  /**
   * `yea()`'s `requireInteraction`, for this tool alone. Default: `yea()`'s. On, it also marks this
   * server's `undo`: undoing acts too.
   */
  requireInteraction?: boolean;
  revert?: RevertFn;
  confirmWith?(plan: HashedPlan, input: Record<string, unknown>): string;
}

/** One rule per key of `GuardConfig` (SPEC-mcp-ts, "Closed options"). */
export const GUARD_CONFIG = {
  describe: required(aFunction),
  risk: aRisk,
  requireInteraction: aBoolean,
  revert: aFunction,
  confirmWith: aFunction,
} satisfies Record<keyof GuardConfig, Rule>;

/** The name `server` registered `tool` under; refuses a tool it can't find there. */
function registeredName(server: McpServer, tool: RegisteredTool): string {
  const found = Object.entries(registryOf(server)).find(([, t]) => t === tool);

  if (!found) {
    throw new Error('guard(): this tool is not registered on this server');
  }

  return found[0];
}

/** The guarded callback: `describe` gives the one plan, and the original handler applies it. */
function guardedCallback(
  y: Yea,
  server: McpServer,
  def: Omit<JobDef, 'plan'> & Pick<GuardConfig, 'describe'>,
  original: { handler: RegisteredTool['handler']; withArgs: boolean },
) {
  const call = original.handler as (...a: unknown[]) => unknown;
  const run = (
    input: Record<string, unknown>,
    reserved: Reserved,
    ctx: ServerContext,
  ) => {
    const apply = () => (original.withArgs ? call(input, ctx) : call(ctx));
    const job: JobDef = {
      ...def,
      plan: async (i) => [{ ...(await def.describe(i)), apply }],
    };

    return runJob({ y, server, job, input, ctx }, reserved);
  };

  // Every guarded tool has the wrapper schema, so the SDK calls this as cb(args, ctx) even for a
  // tool registered without one; `apply` still calls that tool's original as cb(ctx).
  return (args: unknown, ctx: ServerContext) => {
    const { input, ...reserved } = takeReserved(args);

    return run(input, reserved, ctx);
  };
}

/**
 * The wrapper schema for a guarded tool. Like `job()`, it refuses a root that isn't a plain
 * object, or one that already has `preview` or `yea_consent`: the wrapper would shadow the
 * tool's own argument.
 */
function guardSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  try {
    return jobInputSchema(schema);
  } catch (e) {
    throw new TypeError(`guard(): ${errorMessage(e)}`);
  }
}

/**
 * Turn a registered tool into a job without rewriting it (SPEC-mcp-ts `guard`). The SDK has no
 * tool-call middleware (typescript-sdk PR #2820), so this replaces the handler. SDK seam:
 * `RegisteredTool.disable`/`update`/`enable`.
 */
export function guardTool(
  y: Yea,
  server: McpServer,
  tool: RegisteredTool,
  config: GuardConfig,
): string {
  const name = registeredName(server, tool);

  // Guarding twice would wrap the wrapper; a job() tool is already guarded.
  if (tool._meta?.['dev.yea/job'] !== undefined) {
    throw new Error(`guard(): ${name} is already a job tool`);
  }

  const wasEnabled = tool.enabled;

  // Off first, so the original handler can't run in between; if anything below throws, it stays off.
  tool.disable();

  const withArgs = tool.inputSchema !== undefined;
  const callback = guardedCallback(
    y,
    server,
    {
      name,
      risk: config.risk,
      describe: (input) => config.describe(input),
      revert: config.revert,
      confirmWith: config.confirmWith,
      guarded: true,
      ownResultsAreErrors: () => tool.outputSchema !== undefined,
    },
    { handler: tool.handler, withArgs },
  );

  tool.update({
    callback: callback as never,
    // A tool registered without a schema gets one over no input, so it takes preview and
    // yea_consent too (SPEC-approval §6: every job tool does).
    paramsSchema: guardSchema(tool.inputSchema ?? NO_INPUT),
    annotations: jobAnnotations(tool.annotations),
    _meta: {
      ...tool._meta,
      ...jobMeta(
        config.risk,
        config.revert !== undefined,
        config.requireInteraction ?? y.requireInteraction,
      ),
    },
  });

  if (wasEnabled) {
    tool.enable();
  }

  return name;
}
