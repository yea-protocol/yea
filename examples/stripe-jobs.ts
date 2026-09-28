/**
 * The worked example in "From REST to YEA" (site/guide/service-design.md), on the framework: a
 * Stripe-backed billing API as MCP tools, where each write is a job() that returns plans.
 * examples/stripe-billing.ts is the same design as a protocol service.
 *
 *   STRIPE_SECRET_KEY=sk_test_… npx tsx examples/stripe-jobs.ts
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { type Approvals, yea } from '@yea-protocol/mcp';
import {
  clarify,
  type JobPlan,
  lean,
  quantity,
  send,
  update,
} from '@yea-protocol/sdk';
import * as z from 'zod';

const API = 'https://api.stripe.com/v1';

/** The fields of Stripe's objects that this server reads. */
interface Customer {
  id: string;
  name: string;
  email: string;
}

interface Charge {
  id: string;
  created: number;
  amount: number;
  amount_refunded: number;
  currency: string;
  status: string;
}

interface Subscription {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  items: {
    data: {
      current_period_start: number;
      current_period_end: number;
      price: { id: string; nickname: string | null };
    }[];
  };
}

interface List<T> {
  data: T[];
}

export type Stripe = <T = unknown>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, string>,
  idempotencyKey?: string,
) => Promise<T>;

/** The only code that speaks REST. Stripe's errors become messages the model can act on. */
export function connect(key: string, f: typeof fetch): Stripe {
  return async <T>(
    method: string,
    path: string,
    body?: Record<string, string>,
    idempotencyKey?: string,
  ) => {
    const res = await f(API + path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    const json: unknown = await res.json();

    if (!res.ok) {
      const { error } = json as { error?: { message?: string } };

      throw new Error(error?.message ?? `Stripe returned ${res.status}`);
    }

    return json as T;
  };
}

const amt = (minor: number, cur: string) =>
  `${(minor / 100).toFixed(2)} ${cur.toUpperCase()}`;
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const label = (c: Customer) => `${c.name} <${c.email}>`;

/** People say "Chen" or an email, not cus_NffrFeUfNV2Hib. */
async function findCustomers(stripe: Stripe, who: string) {
  if (/^cus_\w+$/.test(who)) {
    return [await stripe<Customer>('GET', `/customers/${who}`)];
  }

  // Stripe wants double-quoted, backslash-escaped strings.
  const q = JSON.stringify(who);
  const query = new URLSearchParams({
    query: `name:${q} OR email:${q}`,
    limit: '5',
  });

  return (await stripe<List<Customer>>('GET', `/customers/search?${query}`))
    .data;
}

/** The one customer `who` names: an ambiguous name is a question back, not a guess. */
async function oneCustomer(
  stripe: Stripe,
  who: string,
  then: (c: Customer) => Promise<JobPlan[]>,
) {
  const m = await findCustomers(stripe, who);

  if (m.length === 0) {
    throw new Error(
      `no customer matches ${JSON.stringify(who)}; try their email`,
    );
  }

  if (m.length > 1) {
    return clarify(
      `${m.length} customers match "${who}". Which one?`,
      m.map((c) => ({ label: label(c), params: { who: c.id } })),
    );
  }

  return then(m[0]);
}

const charges = async (stripe: Stripe, c: Customer) =>
  (
    await stripe<List<Charge>>(
      'GET',
      `/charges?${new URLSearchParams({ customer: c.id, limit: '5' })}`,
    )
  ).data;

async function subscription(stripe: Stripe, c: Customer) {
  const q = new URLSearchParams({
    customer: c.id,
    status: 'active',
    limit: '1',
  });

  return (await stripe<List<Subscription>>('GET', `/subscriptions?${q}`))
    .data[0];
}

// #region read
/** One question, one call: replaces three GETs, and returns only what an agent needs. */
async function customerOverview(stripe: Stripe, who: string) {
  const [c] = await findCustomers(stripe, who);

  if (!c) {
    throw new Error(`no customer matches ${JSON.stringify(who)}`);
  }

  const [sub, chs] = await Promise.all([
    subscription(stripe, c),
    charges(stripe, c),
  ]);

  return {
    id: c.id,
    name: c.name,
    email: c.email,
    plan: sub?.items.data[0].price.nickname ?? 'none',
    renews: sub ? day(sub.items.data[0].current_period_end) : 'never',
    // Flat rows with readable values.
    payments: chs.map((ch) => ({
      id: ch.id,
      date: day(ch.created),
      amount: amt(ch.amount, ch.currency),
      refunded: amt(ch.amount_refunded, ch.currency),
    })),
  };
}
// #endregion read

// #region refund-plan
/** A refund of `amount` (minor units) of one charge. Stripe can't reverse it. */
function refundPlan(
  stripe: Stripe,
  refund: { customer: Customer; charge: Charge; amount: number; why: string },
): JobPlan {
  const { customer: c, charge: ch, amount } = refund;

  return {
    summary: `Refund ${amt(amount, ch.currency)} of ${ch.id} to ${c.name} (${refund.why})`,
    effects: [
      update(
        `charge/${ch.id}`,
        'amount_refunded',
        amt(ch.amount_refunded, ch.currency),
        amt(ch.amount_refunded + amount, ch.currency),
      ),
      send(c.email, 'refund receipt; back on the card in 5–10 days'),
    ],
    uses: {
      spend: quantity(amount, { scale: 2, unit: ch.currency.toUpperCase() }),
    },
    // apply() runs at most once; the key covers a network retry.
    apply: () =>
      stripe(
        'POST',
        '/refunds',
        { charge: ch.id, amount: String(amount) },
        `yea-refund-${ch.id}-${ch.amount_refunded}-${amount}`,
      ),
    // No undoWindow: a refund can't be undone, so the person is always asked.
  };
}
// #endregion refund-plan

/** The latest refundable charge: all of what's left, or the unused part of the period. */
async function refundPlans(stripe: Stripe, c: Customer): Promise<JobPlan[]> {
  const [chs, sub] = await Promise.all([
    charges(stripe, c),
    subscription(stripe, c),
  ]);
  const ch = chs.find(
    (x) => x.status === 'succeeded' && x.amount_refunded < x.amount,
  );

  if (!ch) {
    throw new Error(`${c.name} has no payment left to refund`);
  }

  const left = ch.amount - ch.amount_refunded;
  const plans = [
    refundPlan(stripe, { customer: c, charge: ch, amount: left, why: 'full' }),
  ];
  const unused = sub && ch.id === chs[0].id ? unusedPart(left, sub) : null;

  if (unused) {
    plans.push(refundPlan(stripe, { customer: c, charge: ch, ...unused }));
  }

  return plans;
}

/** The part of `left` that pays for the rest of the period, in whole days. */
function unusedPart(left: number, sub: Subscription) {
  const { current_period_start: start, current_period_end: end } =
    sub.items.data[0];
  const days = Math.floor((end - Date.now() / 1000) / 86_400);
  const amount = Math.round((left * days * 86_400) / (end - start));

  return amount > 0 && amount < left
    ? { amount, why: `unused ${days} days` }
    : null;
}

/** Cancel at the end of the period (undoable), or now (not). */
async function cancelPlans(stripe: Stripe, c: Customer): Promise<JobPlan[]> {
  const sub = await subscription(stripe, c);

  if (!sub) {
    throw new Error(`${c.name} has no active subscription`);
  }

  const path = `/subscriptions/${sub.id}`;
  const end = sub.items.data[0].current_period_end;
  const now: JobPlan = {
    summary: `Cancel ${c.name} now; access ends immediately, no refund`,
    effects: [
      update(`subscription/${sub.id}`, 'status', sub.status, 'canceled'),
    ],
    risk: 'medium',
    apply: () => stripe('DELETE', path),
  };

  if (sub.cancel_at_period_end) {
    return [now];
  }

  // #region cancel-plan
  const atPeriodEnd: JobPlan = {
    summary: `Cancel ${c.name} on ${day(end)}; access until then`,
    effects: [
      update(`subscription/${sub.id}`, 'cancel_at_period_end', false, true),
    ],
    // Whole days, ending before the period does.
    undoWindow: Math.floor((end - Date.now() / 1000) / 86_400) * 86_400,
    apply: async () => {
      await stripe('POST', path, { cancel_at_period_end: 'true' });

      return { subscription: sub.id }; // what revert() gets back as `result`
    },
  };
  // #endregion cancel-plan

  return [atPeriodEnd, now];
}

/** The receipt's subscription id, as apply() returned it. */
function subscriptionOf(result: unknown): string {
  const id = (result as { subscription?: unknown } | null)?.subscription;

  if (typeof id !== 'string') {
    throw new Error('this receipt has no subscription to restore');
  }

  return id;
}

const who = z.object({ who: z.string().describe('name, email or cus_ id') });

/** The billing tools: one read, two jobs. `undo` comes with the first job that has revert. */
export function createServer(approvals: Approvals, stripe: Stripe): McpServer {
  const server = new McpServer(
    { name: 'billing', version: '1.0.0' },
    approvals.serverOptions(),
  );

  // #region read-tool
  server.registerTool(
    'customer',
    {
      description: "A customer's subscription and recent payments",
      inputSchema: who,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const overview = await customerOverview(stripe, input.who);

      // lean() renders it the way YEA shows data to models: flat rows become a table.
      return {
        content: [{ type: 'text', text: lean(overview) }],
        structuredContent: overview,
      };
    },
  );
  // #endregion read-tool

  // #region refund-job
  approvals.job(server, 'refund', {
    description: "Refund a customer's latest payment (irreversible)",
    inputSchema: who,
    risk: 'medium',
    plan: (input) =>
      oneCustomer(stripe, input.who, (c) => refundPlans(stripe, c)),
  });
  // #endregion refund-job

  // #region cancel-job
  approvals.job(server, 'cancel', {
    description: 'Cancel a subscription, now or at the end of the period',
    inputSchema: who,
    risk: 'low',
    plan: (input) =>
      oneCustomer(stripe, input.who, (c) => cancelPlans(stripe, c)),
    // The inverse REST call. Only the undoable plan (at period end) can reach it.
    revert: ({ result }) =>
      stripe('POST', `/subscriptions/${subscriptionOf(result)}`, {
        cancel_at_period_end: 'false',
      }),
  });
  // #endregion cancel-job

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const key = process.env.STRIPE_SECRET_KEY;

  if (!key) {
    throw new Error(
      'set STRIPE_SECRET_KEY (a test-mode sk_test_… key is fine)',
    );
  }

  const approvals = yea({ name: 'billing', transport: 'stdio' });
  const stripe = connect(key, fetch);

  serveStdio(() => createServer(approvals, stripe));
}
