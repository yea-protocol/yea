/**
 * The MCP server: the `customer` read tool and three jobs, registered through
 * `@yea-protocol/mcp`, over one Stripe client.
 */
import {
  fromJsonSchema,
  McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { Approvals } from '@yea-protocol/mcp';
import { isLiveKey, type StripeOptions, stripeApi } from './api.js';
import { cancelJob } from './cancel.js';
import { changeJob } from './change.js';
import { type Ctx, confirmOf, type JobSpec } from './context.js';
import { registerCustomer } from './customer.js';
import { refundJob } from './refund.js';

export const NAME = 'yea-stripe';
export const VERSION = '0.1.0';

export interface ConnectorOptions
  extends Pick<StripeOptions, 'fetch' | 'sleep' | 'newKey' | 'attempts'> {
  /** The Stripe secret or restricted key. Any key without `_test_` is live. */
  key: string;
  /** The approval context, from `yea({ name: 'yea-stripe', … })`, made once per process. */
  approvals: Approvals;
  /** Now, in Unix seconds. Default: the system clock. */
  now?: () => number;
}

/** The shared context the jobs run in. */
export function contextFor(o: Omit<ConnectorOptions, 'approvals'>): Ctx {
  return {
    stripe: stripeApi(o),
    live: isLiveKey(o.key),
    now: o.now ?? (() => Math.floor(Date.now() / 1000)),
  };
}

/** Register one job with the approval plugin. */
function register<I>(
  approvals: Approvals,
  server: McpServer,
  spec: JobSpec<I>,
) {
  const revert = spec.revert;

  approvals.job(server, spec.name, {
    title: spec.title,
    description: spec.description,
    inputSchema: fromJsonSchema<I>(spec.schema),
    risk: spec.risk,
    annotations: { openWorldHint: true },
    plan: (input: I, _ctx: ServerContext) => spec.plan(input),
    ...(revert
      ? {
          revert: (r: { input: I; result: unknown }) =>
            revert(r.input, r.result),
        }
      : {}),
    confirmWith: (hp) => confirmOf(hp),
  });
}

/** Add the four tools to a server. */
export function addStripeTools(
  server: McpServer,
  approvals: Approvals,
  ctx: Ctx,
) {
  registerCustomer(server, ctx);
  register(approvals, server, refundJob(ctx));
  register(approvals, server, cancelJob(ctx));
  register(approvals, server, changeJob(ctx));
}

/**
 * A server factory for `serveStdio` or `createMcpHandler`: a fresh `McpServer` per call, sharing
 * one approval context and one Stripe client.
 */
export function stripeServer(o: ConnectorOptions): () => McpServer {
  const ctx = contextFor(o);

  return () => {
    const server = new McpServer(
      { name: NAME, version: VERSION },
      o.approvals.serverOptions(),
    );

    addStripeTools(server, o.approvals, ctx);

    return server;
  };
}
