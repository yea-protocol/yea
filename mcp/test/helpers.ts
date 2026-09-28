/**
 * The mcp package's fixtures over the shared harness (./harness.ts): a temp YEA home and store,
 * a principal key pinned through the `principal` option (a real pinned file can't be made in a
 * test: the check refuses files this user owns), and a `refund` job.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { type Caveat, decodeGrant, quantity, sha256 } from '@yea-protocol/sdk';
import * as z from 'zod';
import {
  type Approvals,
  type JobConfig,
  type YeaOptions,
  yea,
} from '../src/index.js';
import { freshHome, type Home, installGrant } from './harness.js';

export {
  approve,
  connect,
  type Kind,
  textOf,
  tmp,
} from './harness.js';

export interface World extends Home {
  applied: string[];
  reverted: unknown[];
  approvals: Approvals;
  options: YeaOptions;
}

/** A fresh YEA home, store and principal, and `yea()` over them. */
export async function world(over: Partial<YeaOptions> = {}): Promise<World> {
  const h = await freshHome();
  const options: YeaOptions = {
    name: 'billing',
    transport: 'stdio',
    store: h.store,
    principal: h.principal.public,
    ...over,
  };

  return {
    ...h,
    applied: [],
    reverted: [],
    approvals: yea(options),
    options,
  };
}

/** Issue and install a signed policy grant to the server, for an hour (what `yea grant` makes). */
export const grantPolicy = (
  w: World,
  caveats: Caveat[] = [
    { can: ['refund'] },
    { risk: 'low' },
    { total: { of: 'emails', max: 2 } },
  ],
): Promise<string> => installGrant(w, caveats, 3600);

/** The ledger key a policy's root-block `total` uses. */
export const ledgerKeyOf = async (token: string, of = 'emails') => ({
  block: await sha256(decodeGrant(token)[0].s),
  of,
});

/** The `refund` job: one undoable, low-risk plan that sends one email. */
export function refundJob(
  w: World,
  over: Partial<JobConfig<z.ZodObject<{ charge: z.ZodString }>>> = {},
): JobConfig<z.ZodObject<{ charge: z.ZodString }>> {
  return {
    description: 'Refund what is left of a charge',
    inputSchema: z.object({ charge: z.string() }),
    risk: 'low',
    plan: ({ charge }) => [
      {
        summary: `Refund 20.00 USD of ${charge}`,
        effects: [
          { op: 'create', target: 'refund', detail: `20.00 USD of ${charge}` },
        ],
        uses: { emails: quantity(1) },
        undoWindow: 3600,
        apply: () => {
          w.applied.push(charge);

          return { refunded: charge };
        },
      },
    ],
    revert: ({ input }) => {
      w.reverted.push(input);
    },
    confirmWith: (_hp, { charge }) => charge,
    ...over,
  };
}

/** A server factory with the refund job, as an author writes it. `seen` records verified states. */
export function refundServer(
  w: World,
  over: Partial<JobConfig<z.ZodObject<{ charge: z.ZodString }>>> = {},
  o: { approvals?: Approvals; seen?: string[] } = {},
) {
  const approvals = o.approvals ?? w.approvals;
  const { verify } = approvals.serverOptions().requestState;

  return () => {
    const server = new McpServer(
      { name: 'billing', version: '1.0.0' },
      {
        requestState: {
          verify: (state, ctx) => {
            o.seen?.push(state);

            return verify(state, ctx);
          },
        },
      },
    );

    approvals.job(server, 'refund', refundJob(w, over));

    return server;
  };
}
