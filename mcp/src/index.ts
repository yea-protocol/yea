/**
 * `@yea-protocol/mcp`: the approval contract (docs/framework/SPEC-approval.md) as a plugin for
 * the official TypeScript MCP SDK v2 (docs/framework/SPEC-mcp-ts.md). `yea()` once per process,
 * then `job()` or `guard()` in the server factory.
 */
import {
  createRequestStateCodec,
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
  type HashedPlan,
  isMemoryStore,
  type JobPlan,
  keyPair,
  MemoryStore,
  type Risk,
} from '@yea-protocol/sdk';
import { defaultFileStore, serverKeyPath } from '@yea-protocol/sdk/node';
import type { JobDef, RevertFn, Yea } from './call/context.js';
import { runJob } from './call.js';
import { type GuardConfig, guardTool } from './guard.js';
import { pinnedPrincipal } from './policy.js';
import { jobAnnotations, jobMeta } from './result.js';
import { previewSchema, takePreview } from './schema.js';
import { checkName, loadServerSeed } from './server-key.js';
import { registerUndo, undoFree } from './undo.js';
import { errorMessage, warnOnce } from './util.js';

export { PartialApplyError } from './call/apply.js';

export type { RevertFn, RevertInput } from './call/context.js';

export type { Described, GuardConfig } from './guard.js';

export { errorResult, textResult } from './result.js';

export { PREVIEW } from './schema.js';

export interface YeaOptions {
  /** The server's name, `[a-z0-9._-]{1,64}`: names its key file and appears in consent codes. */
  name: string;
  transport: 'stdio' | 'http';
  /** Default: a FileStore (`YEA_STORE`, else `$YEA_HOME/store`, else `~/.yea/store`) for stdio, a MemoryStore for HTTP. */
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
  o.transport === 'http' ? new MemoryStore() : defaultFileStore();

/** A random per-process codec key: only safe while one process handles every round. */
const randomKey = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

/** Creates the approval context, once per process (SPEC-mcp-ts `yea(options)`). */
export function yea(o: YeaOptions): Approvals {
  checkName(o.name);

  // The default store is a MemoryStore on HTTP; it is only made once the options pass.
  const memory = o.store ? isMemoryStore(o.store) : o.transport === 'http';

  checkOptions(o, memory);

  const store = o.store ?? defaultStore(o);

  const seed = loadServerSeed(o.serverKey ?? serverKeyPath(o.name));
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

  logServiceId(y, o.name);

  return approvalsFor(y);
}

/**
 * One stderr line at start-up with the id `yea grant --to` needs, so the person can find it
 * without reading the key file (SPEC-docs, step 5). stdout belongs to the stdio transport.
 */
function logServiceId(y: Yea, name: string) {
  y.serviceId().then(
    (id) => console.error(`yea: service id ${id} (name ${name})`),
    (e: unknown) => warnOnce(`can't derive the service id: ${errorMessage(e)}`),
  );
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
