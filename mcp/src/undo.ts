/**
 * The `undo` tool: registered once per server, the first time a job with `revert` is added, and
 * the core's `undoJob` for this server's receipts and tools only (SPEC-mcp-ts, "undo").
 */
import {
  type CallToolResult,
  fromJsonSchema,
  type McpServer,
  type RegisteredTool,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { isReceiptId, printable, undoJob, unixNow } from '@yea-protocol/sdk';
import { callerOf, isPartial, type RevertFn, type Yea } from './call.js';
import {
  errorResult,
  REQUIRE_INTERACTION,
  textResult,
  UNDO_ANNOTATIONS,
} from './result.js';
import { errorMessage, registryOf } from './util.js';

/** Throw before registering anything if the server has an `undo` tool that isn't ours. */
export function undoFree(server: McpServer, ours: WeakMap<McpServer, unknown>) {
  if (!ours.has(server) && Object.hasOwn(registryOf(server), 'undo')) {
    throw new Error(
      "this server already has a tool named undo; a job with revert needs YEA's undo tool",
    );
  }
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

/** A server's `undo` tool: the reverts it runs, and its registration, for `promptUndo`. */
export interface UndoTool {
  reverts: Map<string, RevertFn>;
  tool: RegisteredTool;
}

/**
 * The `undo` tool, registered once per server, the first time a job with `revert` is added. It
 * carries Claude Code's prompt-on-every-call key if `prompt`: `yea()`'s setting, or a job's.
 */
export function registerUndo(
  y: Yea,
  server: McpServer,
  all: WeakMap<McpServer, UndoTool>,
  prompt: boolean,
): Map<string, RevertFn> {
  const known = all.get(server);

  if (known) {
    return known.reverts;
  }

  const reverts = new Map<string, RevertFn>();
  const tool = server.registerTool(
    'undo',
    {
      description: 'Undo a job by its receipt id, within its undo window.',
      inputSchema: RECEIPT_SCHEMA,
      annotations: UNDO_ANNOTATIONS,
      ...(prompt ? { _meta: REQUIRE_INTERACTION } : {}),
    },
    (args, ctx) => undoCall(y, reverts, args.receipt, ctx),
  );

  all.set(server, { reverts, tool });

  return reverts;
}

/**
 * Give `server`'s `undo`, if it has one yet, the prompt-on-every-call key: a job with the key
 * makes undoing on its server prompt too, since undoing acts as well (fails closed).
 */
export function promptUndo(
  server: McpServer,
  all: WeakMap<McpServer, UndoTool>,
) {
  all.get(server)?.tool.update({ _meta: { ...REQUIRE_INTERACTION } });
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
      now: unixNow(),
      revert: (r) =>
        revert?.(
          { input: r.input, planHash: r.planHash, result: r.result },
          ctx,
        ),
    });

    return out.kind === 'undone'
      ? textResult(
          [`↶ undid ${out.receipt.id}: ${printable(out.receipt.summary)}`],
          {
            undone: out.receipt.id,
          },
        )
      : errorResult([`✗ ${out.why}; nothing was undone`]);
  } catch (e) {
    // A revert that may have half-happened says so, never "nothing was undone".
    if (isPartial(e)) {
      return errorResult([`✗ undo failed part-way: ${printable(e.message)}`]);
    }

    return errorResult([
      `✗ undo failed: ${printable(errorMessage(e))}; nothing was undone, and it can be tried again`,
    ]);
  }
}
