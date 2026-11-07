/**
 * `@yea-protocol/mcp`: the approval contract (docs/framework/SPEC-approval.md) as a plugin for
 * the official TypeScript MCP SDK v2 (docs/framework/SPEC-mcp-ts.md). `yea()` once per process,
 * then `job()` or `guard()` in the server factory.
 */

import { join } from 'node:path';
import {
  createRequestStateCodec,
  type McpServer,
  type RegisteredTool,
  type RequestStateCodec,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import {
  type ApprovalStore,
  isMemoryStore,
  keyPair,
  MemoryStore,
} from '@yea-protocol/sdk';
import { FileStore, home, serverKeyPath } from '@yea-protocol/sdk/node';
import type { RevertFn, Yea } from './call.js';
import { GUARD_CONFIG, type GuardConfig, guardTool } from './guard.js';
import { JOB_CONFIG, type JobConfig, registerJob } from './job.js';
import { checkOptions } from './options.js';
import { pinnedPrincipal } from './policy.js';
import { checkName, loadServerSeed } from './server-key.js';
import { promptUndo, registerUndo, type UndoTool, undoFree } from './undo.js';
import { errorMessage, warnOnce } from './util.js';
import { YEA_OPTIONS, type YeaOptions } from './yea-options.js';

export type { RevertFn, RevertInput } from './call.js';
export { PartialApplyError } from './call.js';

export type { Described, GuardConfig } from './guard.js';
export type { JobConfig } from './job.js';

export { errorResult, textResult } from './result.js';

export { PREVIEW } from './schema.js';

export type { YeaOptions } from './yea-options.js';

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

/** The start-up refusals that weigh options together (SPEC-mcp-ts `yea()`): nothing is served when one applies. */
function checkCombinations(o: YeaOptions, memory: boolean) {
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

/**
 * A MemoryStore for HTTP; for stdio the FileStore `yea approve` writes to: `YEA_STORE` (read
 * here, once; an empty one counts as unset), else `store` in the home.
 */
const defaultStore = (o: YeaOptions, dir: string): ApprovalStore =>
  o.transport === 'http'
    ? new MemoryStore()
    : new FileStore(process.env.YEA_STORE || join(dir, 'store'));

/** A random per-process codec key: only safe while one process handles every round. */
const randomKey = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

/** Creates the approval context, once per process (SPEC-mcp-ts `yea(options)`). */
export function yea(o: YeaOptions): Approvals {
  // First, so nothing is written (the server key is created on first run) for options that refuse.
  checkOptions('yea()', o, YEA_OPTIONS);
  checkName(o.name);

  // The default store is a MemoryStore on HTTP; it is only made once the options pass.
  const memory = o.store ? isMemoryStore(o.store) : o.transport === 'http';

  checkCombinations(o, memory);

  // The one place the home is resolved; everything below is handed it.
  const dir = o.home ?? home();
  const store = o.store ?? defaultStore(o, dir);

  const seed = loadServerSeed(o.serverKey ?? serverKeyPath(o.name, dir));
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
    principal,
    policy: o.policy,
    tighten: o.tighten ?? {},
    home: dir,
    codec,
    sub,
    serviceId: () => {
      id ??= keyPair(seed).then((k) => k.public);

      return id;
    },
    requireInteraction: o.requireInteraction ?? false,
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
  const undo = new WeakMap<McpServer, UndoTool>();
  // Servers with a job or guard whose own requireInteraction is on: their undo prompts too.
  const prompting = new WeakSet<McpServer>();
  /** Registers through `add` once `undo` is free for a revert, then marks `undo` and adds to it. */
  const register = (
    server: McpServer,
    config: { revert?: unknown; requireInteraction?: boolean },
    add: () => { name: string; tool: RegisteredTool },
  ) => {
    const revert = config.revert as RevertFn | undefined;

    if (revert) {
      undoFree(server, undo);
    }

    const { name, tool } = add();

    if (config.requireInteraction === true) {
      prompting.add(server);
      promptUndo(server, undo);
    }

    if (revert) {
      const prompt = y.requireInteraction || prompting.has(server);

      registerUndo(y, server, undo, prompt).set(name, revert);
    }

    return tool;
  };

  return {
    serverOptions: () => ({ requestState: { verify: y.codec.verify } }),
    serviceId: () => y.serviceId(),
    job: (server, name, config) => {
      checkOptions('job()', config, JOB_CONFIG);

      return register(server, config, () => ({
        name,
        tool: registerJob(y, server, name, config),
      }));
    },
    guard: (server, tool, config) => {
      checkOptions('guard()', config, GUARD_CONFIG);

      return register(server, config, () => ({
        name: guardTool(y, server, tool, config),
        tool,
      }));
    },
  };
}
