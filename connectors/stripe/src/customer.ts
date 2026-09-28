/**
 * `customer`: the read tool. One call answers "who is this and what do they pay": their
 * subscriptions, renewal dates, recent payments and what's left to refund, as Lens.
 */
import {
  type CallToolResult,
  fromJsonSchema,
  type McpServer,
} from '@modelcontextprotocol/server';
import { errorResult, textResult } from '@yea-protocol/mcp';
import { lean } from '@yea-protocol/sdk';
import {
  cancelling,
  errorMessage,
  findCustomers,
  idOf,
  period,
  recentCharges,
  type Stripe,
  subscriptionPage,
} from './api.js';
import { type Ctx, day } from './context.js';
import { formatMoney } from './currency.js';
import {
  howMany,
  inputSchema,
  MAX_MATCHES,
  noMatch,
  priceLabel,
} from './find.js';
import { label, quoted, safeText } from './text.js';

const SCHEMA = fromJsonSchema<{ customer: string }>(inputSchema());

/** A subscription as a flat row. */
function subRow(s: Stripe.Subscription) {
  const end = s.items.data.length ? period(s).end : null;

  return {
    id: s.id,
    plan: s.items.data.map((i) => priceLabel(i.price)).join(' + '),
    status: s.status,
    [cancelling(s) ? 'cancels' : 'renews']: end === null ? null : day(end),
    schedule: s.schedule && idOf(s.schedule),
  };
}

/** A payment as a flat row, with what's left to refund. */
const paymentRow = (ch: Stripe.Charge) => ({
  id: ch.id,
  date: day(ch.created),
  amount: formatMoney(ch.amount, ch.currency),
  refunded: formatMoney(ch.amount_refunded, ch.currency),
  refundable: formatMoney(
    ch.status === 'succeeded' ? ch.amount - ch.amount_refunded : 0,
    ch.currency,
  ),
  status: ch.status,
});

/** Several matches: list them with their ids, and ask which. */
function matchesResult(who: string, found: Stripe.Customer[]) {
  const lines = found.map((m) => `  ${label(m)}`);

  return textResult(
    [
      `? ${howMany(found.length, 'customers match')} ${quoted(who)}. Call again with one of these ids:`,
      ...lines,
    ],
    { matches: lines },
  );
}

async function lookUp(ctx: Ctx, who: string): Promise<CallToolResult> {
  const found = await findCustomers(ctx.stripe, who, MAX_MATCHES);
  const [c] = found;

  if (!c) {
    return errorResult([`✗ ${noMatch(who)}`]);
  }

  if (found.length > 1) {
    return matchesResult(who, found);
  }

  const [chs, page] = await Promise.all([
    recentCharges(ctx.stripe, c.id),
    subscriptionPage(ctx.stripe, c.id),
  ]);
  const view = {
    mode: ctx.live ? 'LIVE' : 'test',
    id: c.id,
    name: typeof c.name === 'string' ? safeText(c.name) : null,
    email: c.email === null ? null : safeText(c.email),
    subscriptions: page.subs.map(subRow),
    ...(page.more
      ? { note: 'more than 100 subscriptions; only the newest 100 are listed' }
      : {}),
    payments: chs.map(paymentRow),
  };

  return textResult([lean(view)], view);
}

/** Register the read tool. */
export function registerCustomer(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'customer',
    {
      title: 'Look up a customer',
      description:
        "Find a customer in your Stripe account, for the Stripe API, by name, email or cus_ id: their subscriptions and renewal dates, recent payments, and what's refundable. Changes nothing.",
      inputSchema: SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ customer }) => {
      try {
        return await lookUp(ctx, customer);
      } catch (e) {
        return errorResult([`✗ ${errorMessage(e)}`]);
      }
    },
  );
}
