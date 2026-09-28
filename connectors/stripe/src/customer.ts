/**
 * `customer`: the read tool. One call answers "who is this and what do they pay": their
 * subscriptions, renewal dates, recent payments and what's left to refund, as Lens.
 */
import {
  type CallToolResult,
  fromJsonSchema,
  type McpServer,
} from '@modelcontextprotocol/server';
import { lean } from '@yea-protocol/sdk';
import {
  type Charge,
  currentSubscriptions,
  findCustomers,
  period,
  recentCharges,
  type Subscription,
} from './api.js';
import { type Ctx, day } from './context.js';
import { formatMoney } from './currency.js';
import { MAX_MATCHES, priceLabel } from './find.js';
import { label, quoted, safeText } from './text.js';

const SCHEMA = fromJsonSchema<{ customer: string }>({
  type: 'object',
  properties: {
    customer: {
      type: 'string',
      description: "The customer's name, email or cus_ id.",
    },
  },
  required: ['customer'],
  additionalProperties: false,
});

const text = (t: string) => [{ type: 'text' as const, text: t }];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A subscription as a flat row. */
function subRow(s: Subscription) {
  const end = s.items.data.length ? period(s).end : null;
  const ends = s.cancel_at_period_end || (s.cancel_at ?? null) !== null;

  return {
    id: s.id,
    plan: s.items.data.map((i) => priceLabel(i.price)).join(' + '),
    status: s.status,
    [ends ? 'cancels' : 'renews']: end === null ? null : day(end),
    schedule: s.schedule,
  };
}

/** A payment as a flat row, with what's left to refund. */
const paymentRow = (ch: Charge) => ({
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
function matchesResult(
  who: string,
  found: { length: number },
  lines: string[],
) {
  const n =
    found.length >= MAX_MATCHES ? `${MAX_MATCHES} or more` : found.length;

  return {
    content: text(
      [
        `? ${n} customers match ${quoted(who)}. Call again with one of these ids:`,
        ...lines,
      ].join('\n'),
    ),
    structuredContent: { matches: lines },
  };
}

async function lookUp(ctx: Ctx, who: string): Promise<CallToolResult> {
  const found = await findCustomers(ctx.stripe, who, MAX_MATCHES);
  const [c] = found;

  if (!c) {
    return {
      content: text(
        `✗ no customer matches ${quoted(who)}; try their exact email or cus_ id`,
      ),
      isError: true,
    };
  }

  if (found.length > 1) {
    return matchesResult(
      who,
      found,
      found.map((m) => `  ${label(m)}`),
    );
  }

  const [chs, subs] = await Promise.all([
    recentCharges(ctx.stripe, c.id),
    currentSubscriptions(ctx.stripe, c.id),
  ]);
  const view = {
    mode: ctx.live ? 'LIVE' : 'test',
    id: c.id,
    name: c.name === null ? null : safeText(c.name),
    email: c.email === null ? null : safeText(c.email),
    subscriptions: subs.map(subRow),
    payments: chs.map(paymentRow),
  };

  return { content: text(lean(view)), structuredContent: view };
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
        return { content: text(`✗ ${message(e)}`), isError: true };
      }
    },
  );
}
