/**
 * A fake of the Stripe endpoints the connector and examples/stripe-billing.ts call: the fetch
 * fake that started in ts/test/stripe-billing.test.ts, extended with prices, invoice previews,
 * subscription schedules, idempotent replays and injected failures. It keeps the state it
 * serves in plain arrays, so tests can look at what changed.
 */
import type { Charge, Customer, Price, Subscription } from '../src/api.js';
import type { Schedule } from '../src/schedule.js';

export const D = 86400;

type FakeCharge = Charge & { customer: string };

export interface FakeState {
  customers: Customer[];
  charges: FakeCharge[];
  subs: Subscription[];
  prices: Price[];
  schedules: Schedule[];
  refunds: { id: string; amount: number; charge: string }[];
}

export interface Call {
  method: string;
  path: string;
  body: string;
  key: string | null;
  version: string | null;
  auth: string | null;
}

/** A failure to inject: the next `times` requests matching it fail this way. */
export interface Failure {
  method?: string;
  path: string | RegExp;
  /** An HTTP error with Stripe's error body. */
  status?: number;
  message?: string;
  /** No response at all. */
  network?: boolean;
  /** Apply the request first, then lose the response (a write whose result is unknown). */
  after?: boolean;
  times?: number;
}

/** A recurring flat price. */
export function price(
  id: string,
  unit_amount: number | null,
  o: Partial<Price> & {
    interval?: string;
    usage_type?: 'licensed' | 'metered';
  } = {},
): Price {
  const { interval = 'month', usage_type = 'licensed', ...rest } = o;

  return {
    id,
    nickname: id.replace(/^price_/, ''),
    currency: 'usd',
    unit_amount,
    billing_scheme: 'per_unit',
    lookup_key: id.replace(/^price_/, ''),
    transform_quantity: null,
    recurring: { interval, interval_count: 1, usage_type },
    ...rest,
  };
}

export const PRICES = (): Price[] => [
  price('price_pro', 4900),
  price('price_basic', 1900),
  price('price_team', 9900),
  price('price_pro_yearly', 49000, { interval: 'year' }),
  price('price_metered', 100, { usage_type: 'metered' }),
  price('price_tiered', null, { billing_scheme: 'tiered' }),
  price('price_eur', 4900, { currency: 'eur' }),
];

/** A one-item subscription on `p`, in a period from `o.start` to `o.end`. */
export function subscription(
  id: string,
  customer: string,
  p: Price,
  o: Partial<Subscription> & { start: number; end: number },
): Subscription {
  const { start, end, ...rest } = o;

  return {
    id,
    customer,
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    discounts: [],
    items: {
      data: [
        {
          id: `si_${id.slice(4)}`,
          quantity: 1,
          current_period_start: start,
          current_period_end: end,
          price: p,
          discounts: [],
        },
      ],
    },
    ...rest,
  };
}

/** The data the guide's example was written against: Chen, two Anas, and Chen's plan. */
export function defaultState(now: number): FakeState {
  const prices = PRICES();
  const pro = prices[0];

  return {
    customers: [
      { id: 'cus_ana1', name: 'Ana Ruiz', email: 'ana.ruiz@acme.co' },
      { id: 'cus_ana2', name: 'Ana Li', email: 'ana@northwind.io' },
      { id: 'cus_chen', name: 'Chen Wei', email: 'chen@wei.studio' },
    ],
    charges: [
      {
        id: 'ch_2',
        customer: 'cus_chen',
        payment_intent: 'pi_2',
        amount: 4900,
        amount_refunded: 0,
        currency: 'usd',
        status: 'succeeded',
        created: now - 16 * D,
      },
      {
        id: 'ch_1',
        customer: 'cus_chen',
        payment_intent: 'pi_1',
        amount: 4900,
        amount_refunded: 0,
        currency: 'usd',
        status: 'succeeded',
        created: now - 46 * D,
      },
    ],
    subs: [
      subscription('sub_chen', 'cus_chen', pro, {
        start: now - 16 * D,
        end: now + 14 * D,
      }),
    ],
    prices,
    schedules: [],
    refunds: [],
  };
}

type Form = Record<string, unknown>;

/** Stripe's `a[b][0]=x` form, back into objects and arrays. */
export function parseForm(body: string): Form {
  const root: Form = {};

  for (const [key, value] of new URLSearchParams(body)) {
    const parts = key.replace(/\]/g, '').split('[');
    let node = root;

    parts.forEach((p, i) => {
      if (i === parts.length - 1) {
        node[p] = value;
      } else {
        node[p] ??= {};
        node = node[p] as Form;
      }
    });
  }

  return arrays(root) as Form;
}

/** Objects whose keys are all 0, 1, 2… become arrays. */
function arrays(v: unknown): unknown {
  if (!v || typeof v !== 'object') {
    return v;
  }

  const o = v as Form;
  const keys = Object.keys(o);
  const mapped = Object.fromEntries(keys.map((k) => [k, arrays(o[k])]));

  return keys.length && keys.every((k, i) => k === String(i))
    ? keys.map((k) => mapped[k])
    : mapped;
}

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stripeError = (status: number, message: string, code?: string) =>
  json(
    {
      error: {
        type: 'invalid_request_error',
        message,
        ...(code ? { code } : {}),
      },
    },
    status,
  );

const missing = (what: string, id: string) =>
  stripeError(404, `No such ${what}: '${id}'`, 'resource_missing');

export type FakeStripe = ReturnType<typeof fakeStripe>;

/** The fake. `now` sets the default data's dates; `state` replaces parts of it. */
export function fakeStripe(
  o: { now?: number; state?: (s: FakeState) => Partial<FakeState> } = {},
) {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const base = defaultState(now);
  const state: FakeState = { ...base, ...o.state?.(base) };
  const calls: Call[] = [];
  const failures: Failure[] = [];
  const replays = new Map<string, { status: number; body: string }>();
  let n = 0;
  const nextId = (prefix: string) => `${prefix}_${++n}`;

  const priceById = (id: unknown) => state.prices.find((p) => p.id === id);
  const subById = (id: unknown) => state.subs.find((s) => s.id === id);
  const schedById = (id: unknown) => state.schedules.find((s) => s.id === id);

  function customers(u: URL, p: string): Response {
    if (p === '/customers/search') {
      // Enough of Stripe's query language for `name:"x" OR email:"x"`: every word must appear.
      const q = u.searchParams.get('query') ?? '';
      const words = (JSON.parse(q.split(' OR ')[0].slice(5)) as string)
        .toLowerCase()
        .split(/\s+/);
      const limit = Number(u.searchParams.get('limit') ?? 10);
      const found = state.customers.filter((c) =>
        words.every(
          (w) =>
            `${c.name} ${c.email}`
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .includes(w) || c.email === w,
        ),
      );

      return json({
        data: found.slice(0, limit),
        has_more: found.length > limit,
      });
    }

    if (p === '/customers') {
      const email = u.searchParams.get('email');
      const limit = Number(u.searchParams.get('limit') ?? 10);

      return json({
        data: state.customers.filter((c) => c.email === email).slice(0, limit),
      });
    }

    const id = p.split('/')[2];
    const c = state.customers.find((x) => x.id === id);

    return c ? json(c) : missing('customer', id);
  }

  function lists(u: URL, p: string): Response | null {
    const q = (k: string) => u.searchParams.get(k);

    if (p === '/charges') {
      return json({
        data: state.charges
          .filter((c) => c.customer === q('customer'))
          .sort((a, b) => b.created - a.created)
          .slice(0, Number(q('limit') ?? 10)),
      });
    }

    if (p === '/subscriptions') {
      const status = q('status');

      return json({
        data: state.subs.filter(
          (s) =>
            s.customer === q('customer') &&
            (status === 'all' ||
              (status ? s.status === status : s.status !== 'canceled')),
        ),
      });
    }

    if (p === '/prices') {
      const key = q('lookup_keys[0]');

      return json({ data: state.prices.filter((x) => x.lookup_key === key) });
    }

    return null;
  }

  function preview(form: Form): Response {
    const sub = subById(form.subscription);
    const d = form.subscription_details as Form | undefined;
    const items = (d?.items ?? []) as Form[];
    const item = sub?.items.data.find((i) => i.id === items[0]?.id);
    const to = priceById(items[0]?.price);
    const at = Number(d?.proration_date);

    if (!sub || !item || !to) {
      return stripeError(400, 'bad preview');
    }

    const { current_period_start: start, current_period_end: end } = item;

    if (!(at >= start && at < end)) {
      return stripeError(
        400,
        'proration_date must be within the current period',
      );
    }

    const q = Number(items[0]?.quantity ?? item.quantity ?? 1);
    const share = (amount: number) =>
      Math.round((amount * q * (end - at)) / (end - start));
    const total =
      share(to.unit_amount ?? 0) - share(item.price.unit_amount ?? 0);

    return json({
      object: 'invoice',
      total,
      amount_due: Math.max(0, total),
      currency: to.currency,
    });
  }

  function refund(form: Form): Response {
    const ch = state.charges.find(
      (c) => c.id === form.charge || c.payment_intent === form.payment_intent,
    );
    const amount = Number(form.amount);

    if (!ch) {
      return missing('charge', String(form.charge ?? form.payment_intent));
    }

    if (amount > ch.amount - ch.amount_refunded) {
      return stripeError(
        400,
        'Refund amount is greater than unrefunded amount',
        'amount_too_large',
      );
    }

    const r = { id: nextId('re'), amount, charge: ch.id };

    ch.amount_refunded += amount;
    state.refunds.push(r);

    return json({ ...r, object: 'refund', status: 'succeeded' });
  }

  function updateSub(sub: Subscription, form: Form, method: string): Response {
    if (method === 'DELETE') {
      sub.status = 'canceled';

      return json(sub);
    }

    if ('cancel_at_period_end' in form) {
      if (sub.schedule) {
        return stripeError(
          400,
          `The subscription is managed by the subscription schedule \`${sub.schedule}\`, and updating any cancelation behavior directly is not allowed. Please update the schedule instead.`,
        );
      }

      sub.cancel_at_period_end = form.cancel_at_period_end === 'true';
    }

    const items = form.items as Form[] | undefined;

    if (items?.[0]) {
      const item = sub.items.data.find((i) => i.id === items[0].id);
      const to = priceById(items[0].price);

      if (!item || !to) {
        return stripeError(400, 'bad item');
      }

      item.price = to;
      item.quantity = Number(items[0].quantity ?? item.quantity);
    }

    return json(sub);
  }

  function createSchedule(form: Form): Response {
    const sub = subById(form.from_subscription);

    if (!sub) {
      return missing('subscription', String(form.from_subscription));
    }

    if (sub.schedule) {
      return stripeError(400, `${sub.id} already has a schedule`);
    }

    const item = sub.items.data[0];
    const start = item.current_period_start;
    const end = item.current_period_end;
    const s: Schedule = {
      id: nextId('sub_sched'),
      subscription: sub.id,
      status: 'active',
      end_behavior: 'release',
      current_phase: { start_date: start, end_date: end },
      phases: [
        {
          start_date: start,
          end_date: end,
          items: [
            {
              price: item.price.id,
              quantity: item.quantity ?? 1,
              tax_rates: [],
              metadata: {},
            },
          ],
          collection_method: 'charge_automatically',
          default_payment_method: null,
          default_tax_rates: [],
          description: null,
          metadata: {},
          currency: item.price.currency,
          trial_end: null,
          discounts: [],
        },
      ],
    };

    state.schedules.push(s);
    sub.schedule = s.id;

    return json(s);
  }

  function updateSchedule(s: Schedule, form: Form): Response {
    if (s.status !== 'active') {
      return stripeError(400, `${s.id} is ${s.status}`);
    }

    if (typeof form.end_behavior === 'string') {
      s.end_behavior = form.end_behavior;
    }

    const phases = form.phases as Form[] | undefined;

    if (phases) {
      if (Number(phases[0]?.start_date) !== s.current_phase?.start_date) {
        return stripeError(400, 'the current phase must keep its start date');
      }

      if (phases.slice(1).some((ph) => !ph.duration && !ph.end_date)) {
        return stripeError(400, 'a later phase needs a duration or end_date');
      }

      s.phases = phases.map((ph, i) => ({
        start_date:
          i === 0 ? Number(ph.start_date) : Number(phases[i - 1].end_date),
        end_date: ph.end_date ? Number(ph.end_date) : null,
        items: (ph.items as Form[]).map((it) => ({
          price: String(it.price),
          quantity: Number(it.quantity ?? 1),
        })),
        ...(ph.duration ? { duration: ph.duration } : {}),
      }));
    }

    return json(s);
  }

  function release(s: Schedule): Response {
    if (s.status !== 'active') {
      return stripeError(
        400,
        `You cannot release a subscription schedule that is currently in the \`${s.status}\` status.`,
      );
    }

    const sub = subById(s.subscription);

    s.status = 'released';

    if (sub) {
      sub.schedule = null;
    }

    return json(s);
  }

  function schedules(p: string, method: string, form: Form): Response {
    const [, , id, action] = p.split('/');

    if (!id && method === 'POST') {
      return createSchedule(form);
    }

    const s = schedById(id);

    if (!s) {
      return missing('subscription schedule', String(id));
    }

    if (method === 'GET') {
      return json(s);
    }

    return action === 'release' ? release(s) : updateSchedule(s, form);
  }

  function route(u: URL, method: string, body: string): Response {
    const p = u.pathname.replace('/v1', '');
    const form = parseForm(body);

    if (p === '/customers' || p.startsWith('/customers/')) {
      return customers(u, p);
    }

    const listed = method === 'GET' ? lists(u, p) : null;

    if (listed) {
      return listed;
    }

    if (p.startsWith('/prices/')) {
      const x = priceById(p.split('/')[2]);

      return x ? json(x) : missing('price', p.split('/')[2]);
    }

    if (p === '/invoices/create_preview') {
      return preview(form);
    }

    if (p === '/refunds') {
      return refund(form);
    }

    if (p.startsWith('/subscriptions/')) {
      const s = subById(p.split('/')[2]);

      if (!s) {
        return missing('subscription', p.split('/')[2]);
      }

      return method === 'GET' ? json(s) : updateSub(s, form, method);
    }

    if (p.startsWith('/subscription_schedules')) {
      return schedules(p, method, form);
    }

    return stripeError(400, `the fake doesn't know ${method} ${p}`);
  }

  const failureFor = (method: string, path: string) =>
    failures.find(
      (f) =>
        (f.times ?? 1) > 0 &&
        (!f.method || f.method === method) &&
        (typeof f.path === 'string' ? path === f.path : f.path.test(path)),
    );

  /** Replays a key's saved response, as Stripe does for 24 hours. */
  async function respond(
    u: URL,
    method: string,
    body: string,
    key: string | null,
  ) {
    const saved = key ? replays.get(key) : undefined;

    if (saved) {
      return new Response(saved.body, { status: saved.status });
    }

    const r = route(u, method, body);

    if (key) {
      replays.set(key, { status: r.status, body: await r.clone().text() });
    }

    return r;
  }

  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = String(init?.body ?? '');
    const headers = new Headers(init?.headers);
    const key = headers.get('idempotency-key');
    const path = u.pathname.replace('/v1', '');

    calls.push({
      method,
      path: u.pathname + u.search,
      body,
      key,
      version: headers.get('stripe-version'),
      auth: headers.get('authorization'),
    });

    const f = failureFor(method, path);

    if (f) {
      f.times = (f.times ?? 1) - 1;

      if (f.after) {
        await respond(u, method, body, key);
      }

      if (f.network || f.after) {
        throw new TypeError('fetch failed');
      }

      return stripeError(
        f.status ?? 500,
        f.message ?? 'An unknown error occurred',
      );
    }

    return respond(u, method, body, key);
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    calls,
    state,
    charges: state.charges,
    subs: state.subs,
    /** Make the next matching request(s) fail. */
    fail: (f: Failure) => {
      failures.push(f);
    },
    /** The requests that changed something: every call but GETs and the invoice preview. */
    writes: () =>
      calls.filter(
        (c) =>
          c.method !== 'GET' &&
          !c.path.startsWith('/v1/invoices/create_preview'),
      ),
  };
}
