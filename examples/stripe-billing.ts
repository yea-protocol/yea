/**
 * A YEA service in front of the real Stripe API: the full example in the
 * "From REST to YEA" guide (site/guide/service-design.md).
 *
 * The agent sees three capabilities, not Stripe's endpoints. Each apply()
 * makes the Stripe call, and each revert() makes the call that reverses it.
 *
 *   STRIPE_SECRET_KEY=sk_test_… YEA_TRUST=ed25519:… \
 *     node examples/stripe-billing.ts
 */
import {
  clarify,
  fix,
  type Plan,
  send,
  service,
  update,
  YeaError,
} from '@yea-protocol/sdk';
// Stripe's official SDK, through the @yea-protocol/stripe connector's client, which pins the API
// version, gives each write a fresh idempotency key, and says what went wrong. The readers
// (findCustomers, recentCharges…) are shared with the connector too.
import {
  currentSubscriptions,
  findCustomers,
  period,
  recentCharges,
  type Stripe,
  type StripeApi,
  StripeError,
  stripeApi,
} from '@yea-protocol/stripe/api';
// Stripe's currency rules: zero- and three-decimal currencies, ISK and UGX.
import {
  formatMoney as amt,
  formatNumber,
  parseMoney,
  roundDown as roundToStep,
  toQuantity,
} from '@yea-protocol/stripe/currency';

const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const roundDown = (secs: number) =>
  secs >= 86400
    ? Math.floor(secs / 86400) * 86400
    : Math.max(0, Math.floor(secs / 3600) * 3600);

export function stripeBilling(opts: {
  key: string;
  trust: string[];
  fetch?: typeof fetch;
}) {
  const stripe = connect(opts.key, opts.fetch);

  return (
    service({
      id: 'billing.stripe.example',
      name: 'Billing (Stripe)',
      summary:
        'Customers, refunds and cancellations on our Stripe account. ' +
        'Refer to customers by name, email or cus_ id. ' +
        "Refunds and immediate cancellations can't be undone.",
      trust: opts.trust,
    })
      // Replaces three GETs: customers/search, subscriptions and charges.
      .ask('billing.customer', {
        summary: "A customer's subscription and recent payments",
        params: { who: 'string — name, email or cus_ id' },
        run: ({ params }) => customerOverview(stripe, params.who),
      })
      // Replaces those GETs, the agent's own math, and POST /v1/refunds.
      .intent('billing.refund', {
        summary: 'Refund a payment (irreversible)',
        params: {
          who: 'string',
          'payment?': 'string — ch_ id; default: the latest',
          'amount?': 'number — a partial refund, in major units',
        },
        risk: 'medium',
        plan: ({ params }) =>
          one(stripe, params.who, (c) => refundPlans(stripe, c, params)),
      })
      // Replaces two endpoints the agent had to tell apart: a reversible POST
      // and a final DELETE. Here they're two plans that say which is which.
      .intent('billing.cancel', {
        summary: 'Cancel a subscription',
        params: { who: 'string' },
        risk: 'low',
        plan: ({ params }) =>
          one(stripe, params.who, (c) => cancelPlans(stripe, c)),
      })
  );
}

/** The connector's Stripe client, whose errors become errors that teach. */
function connect(key: string, f?: typeof fetch): StripeApi {
  const api = stripeApi({ key, fetch: f });
  const taught = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (e) {
      throw e instanceof StripeError ? teach(e) : e;
    }
  };

  return {
    read: (call) => taught(() => api.read(call)),
    write: (call) => taught(() => api.write(call)),
  };
}

function teach(e: StripeError) {
  const { status, message } = e;

  // A write that may have happened must not be retried: with a fresh
  // idempotency key, a retry would be a second refund.
  if (e.unknown) {
    return new YeaError('conflict', message, {
      fix: [fix('ASK billing.customer to see whether it happened')],
    });
  }

  if (status === 404) {
    return new YeaError('not_found', message, {
      fix: [fix('ASK billing.customer with a name or email')],
    });
  }

  if (status === 429) {
    return new YeaError('limit', 'Stripe is rate limiting; retry shortly', {
      retry: 2,
    });
  }

  if (status >= 500 || status === 0) {
    return new YeaError('unavailable', message, { retry: 5 });
  }

  // Params were validated before any REST call, so a 4xx here means the
  // state changed underneath us.
  return new YeaError('conflict', message);
}

// People say "Chen" or an email, not cus_NffrFeUfNV2Hib: findCustomers
// looks an email up exactly, and otherwise searches names and emails.

const label = (c: Stripe.Customer) => `${c.name ?? c.id} <${c.email ?? '-'}>`;
const noMatch = (who: string) =>
  new YeaError('not_found', `no customer matches ${JSON.stringify(who)}`, {
    fix: [fix('try their email address')],
  });

/** For an ASK: an ambiguous name is an error with one fix per candidate. */
async function findOne(stripe: StripeApi, who: string) {
  const m = await findCustomers(stripe, who);

  if (!m.length) {
    throw noMatch(who);
  }

  if (m.length > 1) {
    throw new YeaError(
      'invalid_params',
      `${m.length} customers match ${JSON.stringify(who)}`,
      { fix: m.map((c) => fix(`use ${label(c)}`, { who: c.id })) },
    );
  }

  return m[0];
}

/** For an INTENT: an ambiguous name gets CLARIFY, one option per candidate. */
async function one(
  stripe: StripeApi,
  who: string,
  then: (c: Stripe.Customer) => Promise<Plan | Plan[]>,
) {
  const m = await findCustomers(stripe, who);

  if (!m.length) {
    throw noMatch(who);
  }

  if (m.length > 1) {
    return clarify(
      `${m.length} customers match "${who}". Which one?`,
      m.map((c) => ({ label: label(c), params: { who: c.id } })),
    );
  }

  return then(m[0]);
}

const charges = (stripe: StripeApi, c: Stripe.Customer) =>
  recentCharges(stripe, c.id, 5);
const subscription = async (stripe: StripeApi, c: Stripe.Customer) =>
  (await currentSubscriptions(stripe, c.id))[0] ?? null;

// #region ask
async function customerOverview(stripe: StripeApi, who: string) {
  const c = await findOne(stripe, who);
  const [sub, chs] = await Promise.all([
    subscription(stripe, c),
    charges(stripe, c),
  ]);
  const price = sub?.items.data[0].price;

  return {
    id: c.id,
    name: c.name,
    email: c.email,
    plan: price ? (price.nickname ?? price.id) : 'none',
    ...renewal(sub),
    // Flat rows with only what an agent needs, so Lens renders a table.
    payments: chs.map((ch) => ({
      id: ch.id,
      date: day(ch.created),
      amount: amt(ch.amount, ch.currency),
      refunded: amt(ch.amount_refunded, ch.currency),
      status: ch.status,
    })),
  };
}
// #endregion ask

/** When the current period ends: "renews" on that date, or "cancels". */
function renewal(sub: Stripe.Subscription | null) {
  if (!sub) {
    return {};
  }

  const key = sub.cancel_at_period_end ? 'cancels' : 'renews';

  return { [key]: day(period(sub).end) };
}

async function refundPlans(
  stripe: StripeApi,
  c: Stripe.Customer,
  params: { payment?: string; amount?: number },
): Promise<Plan | Plan[]> {
  const [chs, sub] = await Promise.all([
    charges(stripe, c),
    subscription(stripe, c),
  ]);
  const ch = refundable(chs, c, params.payment);
  const left = ch.amount - ch.amount_refunded;
  const refund = refunder(stripe, c, ch);

  if (params.amount != null) {
    return refund(partial(params.amount, left, ch.currency), 'partial');
  }

  // The choices a person would offer: all of it, or the unused part.
  const plans = [refund(left, 'full')];
  const unused =
    sub && ch.id === chs[0]?.id ? unusedPart(left, sub, ch.currency) : null;

  if (unused) {
    plans.push(refund(unused.amount, `unused ${unused.days} days`));
  }

  return plans;
}

/** The requested charge, or else the latest one with something to refund. */
function refundable(
  chs: Stripe.Charge[],
  c: Stripe.Customer,
  payment?: string,
) {
  const ch = payment
    ? chs.find((x) => x.id === payment)
    : chs.find((x) => x.status === 'succeeded' && x.amount_refunded < x.amount);

  if (ch) {
    return ch;
  }

  throw new YeaError(
    'not_found',
    `no refundable payment${payment ? ` ${payment}` : ''} for ${c.name}`,
    {
      fix: chs.map((x) =>
        fix(`use ${x.id} (${day(x.created)}, ${amt(x.amount, x.currency)})`, {
          payment: x.id,
        }),
      ),
    },
  );
}

/** A partial refund, converted to Stripe's units and checked against `left`. */
function partial(major: number, left: number, cur: string) {
  let amount = 0;

  try {
    amount = parseMoney(String(major), cur);
  } catch {
    amount = 0;
  }

  if (amount > 0 && amount <= left) {
    return amount;
  }

  throw new YeaError(
    'invalid_params',
    `refund must be more than 0 and at most ${amt(left, cur)}, in amounts ${cur.toUpperCase()} allows`,
    {
      fix: [
        fix(`refund the rest (${amt(left, cur)})`, {
          amount: Number(formatNumber(left, cur)),
        }),
      ],
    },
  );
}

/** The part of `left` that pays for the rest of the period, if it's less. */
function unusedPart(left: number, sub: Stripe.Subscription, cur: string) {
  const { start, end } = period(sub);
  const now = Date.now() / 1000;
  const amount = roundToStep(
    Math.round(left * Math.max(0, (end - now) / (end - start))),
    cur,
  );

  if (amount <= 0 || amount >= left) {
    return null;
  }

  return { amount, days: Math.round((end - now) / 86400) };
}

// #region refund-plan
function refunder(stripe: StripeApi, c: Stripe.Customer, ch: Stripe.Charge) {
  return (amount: number, why: string): Plan => ({
    summary:
      `Refund ${amt(amount, ch.currency)} of ${ch.id} to ${c.name}` +
      ` (${why})`,
    effects: [
      update(
        `charge/${ch.id}`,
        'amount_refunded',
        amt(ch.amount_refunded, ch.currency),
        amt(ch.amount_refunded + amount, ch.currency),
      ),
      send(c.email ?? c.id, `refund receipt; back on the card in 5–10 days`),
    ],
    // What the refund spends, by the `spend` convention (docs/conventions.md).
    uses: {
      spend: toQuantity(amount, ch.currency),
    },
    // YEA runs apply() at most once. write() hands the call a fresh
    // idempotency key, which only its own network retries reuse: a key
    // derived from the plan would turn a deliberate second refund into a
    // silent replay.
    apply: () =>
      stripe.write((s, o) =>
        s.refunds.create(
          { charge: ch.id, amount, reason: 'requested_by_customer' },
          o,
        ),
      ),
    // No revert: Stripe can't reverse a refund, so the plan says
    // "undo: never" and YEA never commits it automatically.
  });
}
// #endregion refund-plan

async function cancelPlans(
  stripe: StripeApi,
  c: Stripe.Customer,
): Promise<Plan | Plan[]> {
  const sub = await subscription(stripe, c);

  if (!sub) {
    throw new YeaError('conflict', `${c.name} has no active subscription`);
  }

  const { end } = period(sub);
  const now: Plan = {
    summary: `Cancel ${c.name} now; access ends immediately, no refund`,
    effects: [
      update(`subscription/${sub.id}`, 'status', sub.status, 'canceled'),
    ],
    risk: 'medium',
    // No inverse call exists, so no revert. Stripe ignores idempotency keys
    // on DELETE, so it isn't retried: a lost answer is reported as unknown.
    apply: () =>
      stripe.write((s, o) =>
        s.subscriptions.cancel(sub.id, {}, { ...o, maxNetworkRetries: 0 }),
      ),
  };

  if (sub.cancel_at_period_end) {
    return now;
  }

  // #region cancel-plan
  const atPeriodEnd: Plan = {
    summary: `Cancel ${c.name} on ${day(end)}; access until then`,
    effects: [
      update(`subscription/${sub.id}`, 'cancel_at_period_end', false, true),
    ],
    // Whole days, so it reads "undo: 13d" and ends before the period does.
    undoWindow: roundDown(end - Date.now() / 1000),
    apply: () =>
      stripe.write((s, o) =>
        s.subscriptions.update(sub.id, { cancel_at_period_end: true }, o),
      ),
    // The inverse call.
    revert: () =>
      stripe.write((s, o) =>
        s.subscriptions.update(sub.id, { cancel_at_period_end: false }, o),
      ),
  };
  // #endregion cancel-plan

  return [atPeriodEnd, now];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { listen } = await import('@yea-protocol/sdk/node');
  const key = process.env.STRIPE_SECRET_KEY;

  if (!key) {
    throw new Error(
      'set STRIPE_SECRET_KEY (a test-mode sk_test_… key is fine)',
    );
  }

  const trust = (process.env.YEA_TRUST ?? '').split(',').filter(Boolean);

  await listen(stripeBilling({ key, trust }), { port: 7453 });
  console.error('billing (Stripe) on yea://127.0.0.1:7453');
}
