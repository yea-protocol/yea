// Subscription billing that speaks YEA: the worked example in the service design guide
// (site/guide/service-design.md). It covers the jobs a support or finance agent does with
// a payments API such as Stripe's: look a customer up, refund, change plan, cancel. Here
// they're designed as outcomes instead of resources. The data is made up.
import {
  clarify,
  create,
  fail,
  fix,
  type Plan,
  quantity,
  send,
  service,
  update,
  YeaError,
} from '../index.js';

type PlanId = 'starter' | 'pro' | 'team';

const PRICES: Record<PlanId, number> = { starter: 1900, pro: 4900, team: 9900 };
const DAY = 86400_000;

interface Payment {
  id: string;
  at: number;
  amount: number;
  status: 'paid' | 'failed';
  refunded: number;
}
interface Customer {
  id: string;
  name: string;
  email: string;
  plan: PlanId;
  status: 'active' | 'past_due' | 'canceled';
  card: string;
  renews: number;
  cancelAt: number | null;
  nextPlan: PlanId | null;
  payments: Payment[];
}

const usd = (cents: number) => `${(cents / 100).toFixed(2)} USD`;
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function billing(opts: {
  trust: string[] | ((principal: string) => boolean);
  id?: string;
}) {
  // Computed per call, not at module load: some runtimes (Workers) freeze the clock during startup.
  const now = Date.now();
  const customers = seedCustomers(now);
  const pick = (who: string, then: (c: Customer) => Plan | Plan[]) =>
    pickOne(customers, who, then);

  return service({
    id: opts.id ?? 'billing.example',
    name: 'Example Billing',
    summary:
      "Subscriptions for a SaaS product: plans starter 19, pro 49, team 99 USD/month. Refer to customers by name, email or id. Refunds and immediate cancellations can't be undone.",
    trust: opts.trust,
  })
    .ask('billing.customers', {
      summary: 'Find customers',
      params: {
        'query?': 'string — name or email',
        'status?': 'active|past_due|canceled',
      },
      run: ({ params }) => search(customers, params),
    })
    .ask('billing.customer', {
      summary: 'One customer: plan, card, and recent payments',
      params: { who: 'string — name, email or id' },
      run: ({ params }) => details(findOne(customers, params.who)),
    })
    .intent('billing.refund', {
      summary: 'Refund a payment (irreversible)',
      params: {
        who: 'string',
        'payment?': 'string — default: latest paid',
        'usd?': 'number — partial amount',
        'reason?': 'duplicate|requested_by_customer|fraudulent',
      },
      risk: 'medium',
      plan: ({ params }) =>
        pick(params.who, (c) => refundPlans(c, params, now)),
    })
    .intent('billing.change_plan', {
      summary: 'Move a customer to another plan',
      params: { who: 'string', plan: 'starter|pro|team' },
      risk: 'low',
      plan: ({ params }) =>
        pick(params.who, (c) => changePlans(c, params.plan, now)),
    })
    .intent('billing.cancel', {
      summary: 'Cancel a subscription',
      params: { who: 'string' },
      risk: 'low',
      plan: ({ params }) => pick(params.who, (c) => cancelPlans(c, now)),
    });
}

interface Seed
  extends Pick<Customer, 'id' | 'name' | 'email' | 'plan' | 'card'> {
  renewsInDays: number;
  lastFailed?: boolean;
}

const SEED: Seed[] = [
  {
    id: 'cus_ana_r',
    name: 'Ana Ruiz',
    email: 'ana.ruiz@acme.co',
    plan: 'pro',
    renewsInDays: 21,
    card: 'visa ••4242',
  },
  {
    id: 'cus_ana_l',
    name: 'Ana Li',
    email: 'ana@northwind.io',
    plan: 'team',
    renewsInDays: 9,
    card: 'amex ••1005',
  },
  {
    id: 'cus_ben',
    name: 'Ben Okafor',
    email: 'ben@okafor.dev',
    plan: 'starter',
    renewsInDays: 3,
    card: 'visa ••0341',
    lastFailed: true,
  },
  {
    id: 'cus_chen',
    name: 'Chen Wei',
    email: 'chen@wei.studio',
    plan: 'pro',
    renewsInDays: 14,
    card: 'mc ••7730',
  },
  {
    id: 'cus_dana',
    name: 'Dana Park',
    email: 'dana@park.io',
    plan: 'team',
    renewsInDays: 27,
    card: 'visa ••9921',
  },
];

function seedCustomers(now: number): Customer[] {
  let seq = 100;

  return SEED.map(({ renewsInDays, lastFailed = false, ...c }) => {
    const renews = now + renewsInDays * DAY;
    // Three monthly payments, the latest at the start of the current period.
    const payments = [2, 1, 0].map((k): Payment => {
      seq += 1;

      return {
        id: `pay_${seq}`,
        at: renews - (k + 1) * 30 * DAY,
        amount: PRICES[c.plan],
        status: k === 0 && lastFailed ? 'failed' : 'paid',
        refunded: 0,
      };
    });

    return {
      ...c,
      status: lastFailed ? 'past_due' : 'active',
      renews,
      cancelAt: null,
      nextPlan: null,
      payments,
    };
  });
}

// Agents refer to people the way the user did ("Ana", an email); the service resolves it.
function find(customers: Customer[], who: string) {
  const q = who.toLowerCase().trim();
  const exact = customers.find((c) => c.id === q || c.email === q);

  if (exact) {
    return [exact];
  }

  const words = q.split(/\s+/).filter(Boolean);
  // Each word must start a word of the name or email: "ana" finds Ana Ruiz, not Dana Park.
  const tokens = (c: Customer) =>
    `${c.name} ${c.email}`.toLowerCase().split(/[^a-z0-9]+/);

  return customers.filter((c) =>
    words.every((w) => tokens(c).some((t) => t.startsWith(w))),
  );
}

const label = (c: Customer) => `${c.name} <${c.email}> · ${c.plan}`;
const notFound = (who: string) =>
  fail('not_found', `no customer matches ${JSON.stringify(who)}`, {
    fix: [fix('ASK billing.customers to search')],
  });

// An ASK can't CLARIFY, so an ambiguous read teaches instead: one fix per candidate.
function findOne(customers: Customer[], who: string) {
  const m = find(customers, who);

  if (!m.length) {
    notFound(who);
  }

  if (m.length > 1) {
    fail(
      'invalid_params',
      `${m.length} customers match ${JSON.stringify(who)}`,
      {
        fix: m.map((c) => fix(`use ${label(c)}`, { who: c.id })),
      },
    );
  }

  return m[0];
}

// Intents answer ambiguity with CLARIFY; each option is a params patch the agent merges.
function pickOne(
  customers: Customer[],
  who: string,
  then: (c: Customer) => Plan | Plan[],
) {
  const m = find(customers, who);

  if (!m.length) {
    notFound(who);
  }

  if (m.length > 1) {
    return clarify(
      `${m.length} customers match "${who}". Which one?`,
      m.map((c) => ({ label: label(c), params: { who: c.id } })),
    );
  }

  return then(m[0]);
}

const periodLeft = (c: Customer, now: number) =>
  Math.max(0, (c.renews - now) / (30 * DAY));

function search(
  customers: Customer[],
  params: { query?: string; status?: string },
) {
  return (params.query ? find(customers, params.query) : customers)
    .filter((c) => !params.status || c.status === params.status)
    .map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      plan: c.plan,
      status: c.status,
      renews: date(c.renews),
    }));
}

function details(c: Customer) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    plan: c.plan,
    usd_month: PRICES[c.plan] / 100,
    status: c.status,
    card: c.card,
    renews: date(c.renews),
    ...(c.nextPlan ? { next_plan: c.nextPlan } : {}),
    ...(c.cancelAt ? { cancels: date(c.cancelAt) } : {}),
    payments: c.payments.map((p) => ({
      id: p.id,
      date: date(p.at),
      usd: p.amount / 100,
      status: p.status,
      refunded_usd: p.refunded / 100,
    })),
  };
}

function refundPlans(
  c: Customer,
  params: { payment?: string; usd?: number },
  now: number,
): Plan | Plan[] {
  const paid = c.payments.filter((p) => p.status === 'paid');
  const pay = params.payment
    ? c.payments.find((p) => p.id === params.payment)
    : paid.at(-1);

  if (!pay) {
    return fail(
      'not_found',
      `no payment ${JSON.stringify(params.payment)} for ${c.name}`,
      {
        fix: paid.map((p) =>
          fix(`use ${p.id} (${date(p.at)}, ${usd(p.amount)})`, {
            payment: p.id,
          }),
        ),
      },
    );
  }

  const left = pay.amount - pay.refunded;

  if (pay.status !== 'paid' || left <= 0) {
    return fail('conflict', `${pay.id} has nothing left to refund`);
  }

  const refund = refunder(c, pay);

  if (params.usd != null) {
    return refund(partial(params.usd, left), 'partial');
  }

  // Alternatives CRUD can't express: the whole payment, or only the unused part of this period.
  const unused = Math.round(left * periodLeft(c, now));
  const current = pay === paid.at(-1) && unused > 0 && unused < left;

  return current
    ? [
        refund(left, 'full'),
        refund(unused, `unused ${Math.round(periodLeft(c, now) * 30)} days`),
      ]
    : refund(left, 'full');
}

// A partial refund in dollars, in cents once checked against what's left.
function partial(dollars: number, left: number) {
  const amount = Math.round(dollars * 100);

  if (amount > 0 && amount <= left) {
    return amount;
  }

  throw new YeaError(
    'invalid_params',
    `refund must be between 0.01 and ${usd(left)}`,
    { fix: [fix(`refund the rest (${usd(left)})`, { usd: left / 100 })] },
  );
}

function refunder(c: Customer, pay: Payment) {
  return (amount: number, why: string): Plan => ({
    summary: `Refund ${usd(amount)} of ${pay.id} to ${c.name} (${why})`,
    effects: [
      update(
        `payment/${pay.id}`,
        'refunded',
        usd(pay.refunded),
        usd(pay.refunded + amount),
      ),
      send(
        c.email,
        `refund receipt, ${usd(amount)} back to ${c.card} in 5–10 days`,
      ),
    ],
    uses: spent(amount),
    apply: () => {
      pay.refunded += amount;

      return { refunded: usd(amount), payment: pay.id };
    },
    // No revert: money that has left can't be pulled back, so the proposal says undo: none.
  });
}

/** Cents charged or refunded, reported under the `spend` convention (docs/conventions.md). */
const spent = (cents: number) => ({
  spend: quantity(cents, { scale: 2, unit: 'USD' }),
});

function changePlans(c: Customer, to: PlanId, now: number): Plan[] {
  const from = c.plan;

  if (to === from) {
    return fail('conflict', `${c.name} is already on ${to}`, {
      fix: (Object.keys(PRICES) as PlanId[])
        .filter((p) => p !== to)
        .map((p) => fix(`move to ${p}`, { plan: p })),
    });
  }

  const diff = Math.round((PRICES[to] - PRICES[from]) * periodLeft(c, now));
  const sub = `subscription/${c.id}`;
  const immediate: Plan = {
    summary: `${c.name}: ${from} → ${to} now, ${diff > 0 ? `charge ${usd(diff)} prorated` : `credit ${usd(-diff)} to next invoice`}`,
    effects: [
      update(sub, 'plan', from, to),
      diff > 0
        ? create('charge', `${usd(diff)} prorated to ${c.card}`)
        : update(`customer/${c.id}`, 'credit', '0.00 USD', usd(-diff)),
      send(c.email, 'plan change receipt'),
    ],
    ...(diff > 0 ? { uses: spent(diff) } : {}),
    undoWindow: 86400,
    apply: () => {
      c.plan = to;

      return { plan: to };
    },
    revert: () => {
      c.plan = from;
    },
  };
  const later: Plan = {
    summary: `${c.name}: ${from} → ${to} on ${date(c.renews)}, nothing charged today`,
    effects: [update(sub, 'plan', from, to, `from ${date(c.renews)}`)],
    undoWindow: Math.floor((c.renews - now) / 1000),
    // Scheduled, not applied: until renewal the customer is still on (and billed for) the old plan.
    apply: () => {
      c.nextPlan = to;

      return { plan: to, from: date(c.renews) };
    },
    revert: () => {
      c.nextPlan = null;
    },
  };

  return [immediate, later];
}

function cancelPlans(c: Customer, now: number): Plan[] {
  if (c.status === 'canceled') {
    return fail('conflict', `${c.name} is already canceled`);
  }

  const sub = `subscription/${c.id}`;
  const atPeriodEnd: Plan = {
    summary: `Cancel ${c.name} on ${date(c.renews)}; access until then`,
    effects: [
      update(sub, 'cancels', null, date(c.renews)),
      send(c.email, 'cancellation confirmation'),
    ],
    // Reversible until the period ends: the customer can simply stay.
    undoWindow: Math.floor((c.renews - now) / 1000),
    apply: () => {
      c.cancelAt = c.renews;

      return { cancels: date(c.renews) };
    },
    revert: () => {
      c.cancelAt = null;
    },
  };
  const immediately: Plan = {
    summary: `Cancel ${c.name} now; access ends immediately, no refund`,
    effects: [
      update(sub, 'status', c.status, 'canceled'),
      send(c.email, 'cancellation confirmation'),
    ],
    risk: 'medium',
    apply: () => {
      c.status = 'canceled';

      return { status: 'canceled' };
    },
  };

  return [atPeriodEnd, immediately];
}
