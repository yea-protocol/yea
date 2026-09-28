/**
 * `@yea-protocol/mcp`: the approval contract (docs/framework/SPEC-approval.md) as a plugin for
 * the official TypeScript MCP SDK v2 (docs/framework/SPEC-mcp-ts.md). `yea()` once per process,
 * then `job()` or `guard()` in the server factory.
 */
import {
  type CallToolResult,
  createRequestStateCodec,
  fromJsonSchema,
  type McpServer,
  type RegisteredTool,
  type RequestStateCodec,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import {
  type ApprovalStore,
  type Clarification,
  type Effect,
  type HashedPlan,
  isMemoryStore,
  isReceiptId,
  type JobPlan,
  keyPair,
  MemoryStore,
  type Risk,
  type Uses,
  undoJob,
} from '@yea-protocol/sdk';
import { FileStore } from '@yea-protocol/sdk/node';
import {
  callerOf,
  type JobDef,
  type RevertFn,
  runJob,
  type Yea,
} from './call.js';
import {
  checkName,
  defaultKeyPath,
  loadServerSeed,
  pinnedPrincipal,
  warnOnce,
} from './keys.js';
import { errorResult } from './render.js';
import { previewSchema, takePreview } from './schema.js';

export type { RevertFn, RevertInput } from './call.js';

export { canAsk, canElicitForm } from './client.js';

export { PREVIEW } from './schema.js';

/**
 * Thrown by an `apply()` that failed after changing something, so the result doesn't say
 * "nothing changed". Its message says what was left behind, and how to fix it.
 */
export class PartialApplyError extends Error {
  readonly partial = true;
}

export interface YeaOptions {
  /** The server's name, `[a-z0-9._-]{1,64}`: names its key file and appears in consent codes. */
  name: string;
  transport: 'stdio' | 'http';
  /** Default: a FileStore (`YEA_STORE`, else `~/.yea/store`) for stdio, a MemoryStore for HTTP. */
  store?: ApprovalStore;
  /** HTTP only: a promise that one process serves every request. HTTP on a MemoryStore must set it. */
  singleProcess?: boolean;
  /** Path to the server's Ed25519 seed. Default `~/.yea/server/<name>.key`, created on first run. */
  serverKey?: string;
  /** The pinned principal public key. Default: the file `YEA_PRINCIPAL_PUB` names, checked. */
  principal?: string;
  /** The signed policy grant: a `pg1.` token, or a path to one. Default `YEA_POLICY`. */
  policy?: string;
  /** Unsigned tightening, merged with `~/.yea/policy.json`: `{ deny?, outOfBand? }`. */
  tighten?: { deny?: string[]; outOfBand?: Risk };
  /** An existing `createRequestStateCodec` result; our state lives under its payload's `yea` key. */
  codec?: RequestStateCodec<unknown>;
  /** The ≥ 32-byte codec key. Only with a store every process shares. Default: random. */
  stateKey?: Uint8Array | string;
  /** Who is calling. stdio: `() => ''`. HTTP: required, from the transport's authentication. */
  sub?: (ctx: ServerContext) => string;
}

/** What a guarded tool's `describe(input)` returns: a plan without `apply`. */
export interface Described {
  summary: string;
  effects: Effect[];
  uses?: Uses;
  risk?: Risk;
  undoWindow?: number;
}

export interface JobConfig<S extends StandardSchemaWithJSON> {
  title?: string;
  description?: string;
  annotations?: ToolAnnotations;
  inputSchema: S;
  /** The tool's default plan risk; a plan's own `risk` wins. Default `medium`. */
  risk?: Risk;
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

export interface GuardConfig {
  describe(input: Record<string, unknown>): Described | Promise<Described>;
  /** The tool's default plan risk, and its `_meta` risk; `describe`'s own `risk` wins. Default `medium`. */
  risk?: Risk;
  revert?: RevertFn;
  confirmWith?(plan: HashedPlan, input: Record<string, unknown>): string;
}

export interface Approvals {
  /** Options for `new McpServer`: installs the codec that verifies our `requestState`. */
  serverOptions(): {
    requestState: { verify: RequestStateCodec<unknown>['verify'] };
  };
  /** This server's service id (its public key): policy and consent grants are issued to it. */
  serviceId(): Promise<string>;
  job<S extends StandardSchemaWithJSON>(
    server: McpServer,
    name: string,
    config: JobConfig<S>,
  ): RegisteredTool;
  guard(
    server: McpServer,
    tool: RegisteredTool,
    config: GuardConfig,
  ): RegisteredTool;
}

/** The start-up refusals (SPEC-mcp-ts `yea()`): nothing is served when one applies. */
function checkOptions(o: YeaOptions, memory: boolean) {
  if (o.transport !== 'stdio' && o.transport !== 'http') {
    throw new TypeError("yea(): transport must be 'stdio' or 'http'");
  }

  if (o.transport === 'http' && typeof o.sub !== 'function') {
    throw new TypeError(
      'yea(): HTTP needs sub(ctx), the authenticated person calling (not an OAuth clientId)',
    );
  }

  if (o.stateKey !== undefined && memory) {
    throw new TypeError(
      'yea(): a shared stateKey needs a shared store; with a MemoryStore each process would accept the same approval once',
    );
  }

  if (o.transport === 'http' && memory && o.singleProcess !== true) {
    throw new TypeError(
      'yea(): HTTP on a MemoryStore needs singleProcess: true, or pass a store every process shares',
    );
  }

  if (o.codec && o.stateKey !== undefined) {
    throw new TypeError('yea(): pass either codec or stateKey, not both');
  }
}

const defaultStore = (o: YeaOptions): ApprovalStore =>
  o.transport === 'http'
    ? new MemoryStore()
    : new FileStore(process.env.YEA_STORE || undefined);

/** A random per-process codec key: only safe while one process handles every round. */
const randomKey = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

/** Creates the approval context, once per process (SPEC-mcp-ts `yea(options)`). */
export function yea(o: YeaOptions): Approvals {
  checkName(o.name);

  // The default store is a MemoryStore on HTTP; it is only made once the options pass.
  const memory = o.store ? isMemoryStore(o.store) : o.transport === 'http';

  checkOptions(o, memory);

  const store = o.store ?? defaultStore(o);

  const seed = loadServerSeed(o.serverKey ?? defaultKeyPath(o.name));
  const sub = o.sub ?? (() => '');
  const codec =
    o.codec ??
    createRequestStateCodec<unknown>({
      key: o.stateKey ?? randomKey(),
      ttlSeconds: 600,
      bind: (ctx) => `${ctx.mcpReq.method}\0${sub(ctx)}`,
    });
  const principal = pinnedPrincipal(o.principal);
  let id: Promise<string> | undefined;

  if ('why' in principal) {
    warnOnce(
      `no pinned principal key (${principal.why}): nothing auto-runs and no consent is accepted`,
    );
  }

  const y: Yea = {
    transport: o.transport,
    store,
    memoryStore: memory,
    principal,
    policy: o.policy,
    tighten: o.tighten ?? {},
    codec,
    sub,
    serviceId: () => {
      id ??= keyPair(seed).then((k) => k.public);

      return id;
    },
  };

  return approvalsFor(y);
}

function approvalsFor(y: Yea): Approvals {
  const undo = new WeakMap<McpServer, Map<string, RevertFn>>();
  const addRevert = (
    server: McpServer,
    name: string,
    revert: RevertFn | undefined,
  ) => {
    if (revert) {
      registerUndo(y, server, undo).set(name, revert);
    }
  };

  return {
    serverOptions: () => ({ requestState: { verify: y.codec.verify } }),
    serviceId: () => y.serviceId(),
    job: (server, name, config) => {
      if (config.revert) {
        undoFree(server, undo);
      }

      const tool = registerJob(y, server, name, config);

      addRevert(server, name, config.revert as RevertFn | undefined);

      return tool;
    },
    guard: (server, tool, config) => {
      if (config.revert) {
        undoFree(server, undo);
      }

      const name = guardTool(y, server, tool, config);

      addRevert(server, name, config.revert);

      return tool;
    },
  };
}

/** Throw before registering anything if the server has an `undo` tool that isn't ours. */
function undoFree(server: McpServer, ours: WeakMap<McpServer, unknown>) {
  if (!ours.has(server) && Object.hasOwn(registryOf(server), 'undo')) {
    throw new Error(
      "this server already has a tool named undo; a job with revert needs YEA's undo tool",
    );
  }
}

/** The tool's risk metadata (SPEC-mcp-ts, "Risk metadata"). */
const jobMeta = (risk: Risk | undefined, undoable: boolean) => ({
  'dev.yea/job': { risk: risk ?? 'medium', undoable },
});

/** A job changes things: destructive unless the author says otherwise. Hints, not enforcement. */
const jobAnnotations = (a: ToolAnnotations | undefined): ToolAnnotations => ({
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: true,
  ...a,
});

function registerJob<S extends StandardSchemaWithJSON>(
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
      _meta: jobMeta(config.risk, config.revert !== undefined),
    },
    (args: unknown, ctx: ServerContext) => {
      const { input, preview } = takePreview(args);

      return runJob({ y, server, job: def, input, ctx }, preview);
    },
  );
}

/**
 * The server's tool registry. SDK seam: `RegisteredTool` doesn't carry its name and the registry
 * is private, so this reads it through a narrow cast; an empty object if it isn't there.
 */
function registryOf(server: McpServer): Record<string, unknown> {
  const registry = (server as unknown as { _registeredTools?: unknown })
    ._registeredTools;

  return registry && typeof registry === 'object'
    ? (registry as Record<string, unknown>)
    : {};
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
    throw new TypeError(
      `guard(): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Turn a registered tool into a job without rewriting it (SPEC-mcp-ts `guard`). The SDK has no
 * tool-call middleware (typescript-sdk PR #2820), so this replaces the handler. SDK seam:
 * `RegisteredTool.disable`/`update`/`enable`.
 */
function guardTool(
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

const RECEIPT_SCHEMA = fromJsonSchema<{ receipt: string }>({
  type: 'object',
  properties: {
    receipt: {
      type: 'string',
      description: 'The receipt id of the job to undo.',
    },
  },
  required: ['receipt'],
});

/** The `undo` tool, registered once per server, the first time a job with `revert` is added. */
function registerUndo(
  y: Yea,
  server: McpServer,
  all: WeakMap<McpServer, Map<string, RevertFn>>,
): Map<string, RevertFn> {
  const known = all.get(server);

  if (known) {
    return known;
  }

  const reverts = new Map<string, RevertFn>();

  all.set(server, reverts);
  server.registerTool(
    'undo',
    {
      description: 'Undo a job by its receipt id, within its undo window.',
      inputSchema: RECEIPT_SCHEMA,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    (args, ctx) => undoCall(y, reverts, args.receipt, ctx),
  );

  return reverts;
}

/** `undo({ receipt })`: the core's `undoJob`, for this server's receipts and tools only. */
async function undoCall(
  y: Yea,
  reverts: Map<string, RevertFn>,
  id: string,
  ctx: ServerContext,
): Promise<CallToolResult> {
  try {
    const sub = callerOf(y, ctx);

    // A receipt for a tool with no revert here is unknown, like one from another server.
    const found = isReceiptId(id) ? await y.store.getReceipt(id) : null;
    const revert = found ? reverts.get(found.tool) : undefined;
    const out = await undoJob(y.store, {
      id: revert ? id : null,
      service: await y.serviceId(),
      sub,
      now: Math.floor(Date.now() / 1000),
      revert: (r) =>
        revert?.(
          { input: r.input, planHash: r.planHash, result: r.result },
          ctx,
        ),
    });

    return out.kind === 'undone'
      ? {
          content: [
            {
              type: 'text',
              text: `↶ undid ${out.receipt.id}: ${out.receipt.summary}`,
            },
          ],
          structuredContent: { undone: out.receipt.id },
        }
      : errorResult([`✗ ${out.why}; nothing was undone`]);
  } catch (e) {
    return errorResult([
      `✗ undo failed: ${e instanceof Error ? e.message : String(e)}; nothing was undone, and it can be tried again`,
    ]);
  }
}
