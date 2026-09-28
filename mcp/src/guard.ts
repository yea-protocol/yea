/**
 * `guard()`: turn a tool already registered into a job, by replacing its handler through
 * `RegisteredTool.update` (SPEC-mcp-ts `guard`).
 */
import type {
  McpServer,
  RegisteredTool,
  ServerContext,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import type { Effect, HashedPlan, Risk, Uses } from '@yea-protocol/sdk';
import type { JobDef, RevertFn, Yea } from './call/context.js';
import { runJob } from './call.js';
import { jobAnnotations, jobMeta } from './result.js';
import { previewSchema, takePreview } from './schema.js';
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
  revert?: RevertFn;
  confirmWith?(plan: HashedPlan, input: Record<string, unknown>): string;
}

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
    preview: boolean,
    ctx: ServerContext,
  ) => {
    const apply = () => (original.withArgs ? call(input, ctx) : call(ctx));
    const job: JobDef = {
      ...def,
      plan: async (i) => [{ ...(await def.describe(i)), apply }],
    };

    return runJob({ y, server, job, input, ctx }, preview);
  };

  // A tool registered without a schema is called as cb(ctx), and gets no preview.
  return original.withArgs
    ? (args: unknown, ctx: ServerContext) => {
        const { input, preview } = takePreview(args);

        return run(input, preview, ctx);
      }
    : (ctx: ServerContext) => run({}, false, ctx);
}

/**
 * The wrapper schema for a guarded tool. Like `job()`, it refuses a root that isn't a plain
 * object, or one that already has `preview`: the wrapper would shadow the tool's own argument.
 */
function guardSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  try {
    return previewSchema(schema);
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
    ...(tool.inputSchema
      ? { paramsSchema: guardSchema(tool.inputSchema) }
      : {}),
    annotations: jobAnnotations(tool.annotations),
    _meta: {
      ...tool._meta,
      ...jobMeta(config.risk, config.revert !== undefined),
    },
  });

  if (wasEnabled) {
    tool.enable();
  }

  return name;
}
