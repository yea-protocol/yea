/**
 * A fake of the Stripe endpoints the connector and examples/stripe-billing.ts call, as the
 * `fetch` the SDK sends with (`Stripe.createFetchHttpClient`): customers, charges, prices,
 * invoice previews, subscriptions and schedules, with idempotent replays and injected failures.
 * It keeps the state it serves in plain arrays, so tests can look at what changed. Its objects
 * carry only the fields the connector reads.
 */
import { unixNow } from '@yea-protocol/sdk';

export const D = 86400;

export interface Customer {
  id: string;
  name: string | null;
  email: string | null;
  deleted?: boolean;
  /** Negative is credit, as Stripe keeps it. */
  balance?: number;
}

export interface Charge {
  id: string;
  customer: string;
  created: number;
  amount: number;
  amount_refunded: number;
  currency: string;
  status: string;
  payment_intent: string | null;
}

export interface Price {
  id: string;
  active: boolean;
  nickname: string | null;
  currency: string;
  unit_amount: number | null;
  billing_scheme?: 'per_unit' | 'tiered';
  lookup_key: string | null;
  transform_quantity: unknown;
  recurring: {
    interval: string;
    interval_count: number;
    usage_type: 'licensed' | 'metered';
  } | null;
}

export interface SubscriptionItem {
  id: string;
  quantity?: number;
  current_period_start: number;
  current_period_end: number;
  price: Price;
  discounts: unknown[];
}

export interface Subscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  schedule: string | null;
  pending_update: {
    expires_at?: number;
    subscription_items?: unknown[];
  } | null;
  latest_invoice: string | null;
  discounts: unknown[];
  items: { data: SubscriptionItem[] };
}

export interface SchedulePhase {
  start_date: number;
  end_date: number | null;
  items: { price: string; quantity?: number; [setting: string]: unknown }[];
  [setting: string]: unknown;
}

export interface Schedule {
  id: string;
  subscription: string | null;
  status: string;
  end_behavior: string;
  phases: SchedulePhase[];
  current_phase: { start_date: number; end_date: number } | null;
}

export interface FakeState {
  customers: Customer[];
  charges: Charge[];
  subs: Subscription[];
  prices: Price[];
  schedules: Schedule[];
  refunds: {
    id: string;
    amount: number;
    charge: string;
    created: number;
    status: string;
  }[];
  /** Every prorated price change, with the date it was prorated from. */
  prorations: { subscription: string; at: number; total: number }[];
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
  /** The lost connection's code, such as `ECONNRESET`, which the SDK retries even with retries off. */
  code?: string;
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
    active: true,
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
    pending_update: null,
    latest_invoice: null,
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
    prorations: [],
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

/** Each fake response's body, so it can be read again without awaiting. */
const syncText = new WeakMap<Response, string>();

function json(x: unknown, status = 200): Response {
  const text = JSON.stringify(x);
  const r = new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });

  syncText.set(r, text);

  return r;
}

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
  o: {
    now?: number;
    state?: (s: FakeState) => Partial<FakeState>;
    /** The `livemode` every object is stamped with, as Stripe does. Default: false (test mode). */
    livemode?: boolean;
    /** Decline every card: a price change that charges stays pending. */
    declines?: boolean;
  } = {},
) {
  const declines = o.declines ?? false;
  let scheduled: ((s: Schedule) => void) | undefined;
  const now = o.now ?? unixNow();
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

  /** One page of a list, as Stripe pages it: at most `limit`, and whether there is more. */
  const page = <T>(all: T[], limit: string | null) => {
    const n = Number(limit ?? 10);

    return { object: 'list', data: all.slice(0, n), has_more: all.length > n };
  };

  function lists(u: URL, p: string): Response | null {
    const q = (k: string) => u.searchParams.get(k);

    if (p === '/charges') {
      return json(
        page(
          state.charges
            .filter((c) => c.customer === q('customer'))
            .sort((a, b) => b.created - a.created),
          q('limit'),
        ),
      );
    }

    if (p === '/subscriptions') {
      const status = q('status');

      // Newest first, and by default without cancelled ones, as Stripe lists them.
      return json(
        page(
          state.subs
            .filter(
              (s) =>
                s.customer === q('customer') &&
                (status === 'all' ||
                  (status ? s.status === status : s.status !== 'canceled')),
            )
            .reverse(),
          q('limit'),
        ),
      );
    }

    if (p === '/refunds') {
      return json(
        page(
          state.refunds.filter((r) => r.charge === q('charge')).reverse(),
          q('limit'),
        ),
      );
    }

    if (p === '/prices') {
      const key = q('lookup_keys[0]');

      return json(
        page(
          state.prices.filter(
            (x) =>
              x.lookup_key === key &&
              (q('active') !== 'true' || x.active === true),
          ),
          q('limit'),
        ),
      );
    }

    return null;
  }

  /** The net of prorating `item` onto `to` from `at`, or why Stripe would refuse. */
  function prorate(
    item: Subscription['items']['data'][number],
    to: Price,
    o: { at: number; quantity: number },
  ): number | string {
    const { current_period_start: start, current_period_end: end } = item;

    if (!(o.at >= start && o.at < end)) {
      return 'proration_date must be within the current period';
    }

    const share = (amount: number) =>
      Math.round((amount * o.quantity * (end - o.at)) / (end - start));

    return share(to.unit_amount ?? 0) - share(item.price.unit_amount ?? 0);
  }

  /** A customer's credit balance (negative, as Stripe keeps it), applied to what's due. */
  const due = (customer: string, total: number) => {
    const c = state.customers.find((x) => x.id === customer);

    return Math.max(0, total + Math.min(0, c?.balance ?? 0));
  };

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

    const total = prorate(item, to, {
      at,
      quantity: Number(items[0]?.quantity ?? item.quantity ?? 1),
    });

    if (typeof total === 'string') {
      return stripeError(400, total);
    }

    return json({
      object: 'invoice',
      total,
      amount_due: due(sub.customer, total),
      currency: to.currency,
      lines: {
        data: [
          {
            amount: total,
            parent: { subscription_item_details: { proration: true } },
          },
        ],
      },
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

    const r = {
      id: nextId('re'),
      amount,
      charge: ch.id,
      created: now,
      status: 'succeeded',
    };

    ch.amount_refunded += amount;
    state.refunds.push(r);

    return json({ ...r, object: 'refund', status: 'succeeded' });
  }

  function updateSub(sub: Subscription, form: Form, method: string): Response {
    if (method === 'DELETE') {
      if (sub.status === 'canceled') {
        return stripeError(
          400,
          `The subscription ${sub.id} has already been canceled.`,
        );
      }

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
      return changeItem(sub, items[0], form);
    }

    return json(sub);
  }

  /**
   * A price change, prorated from `proration_date`. With `pending_if_incomplete`, a declined
   * payment leaves the change pending and the old price on.
   */
  function changeItem(sub: Subscription, wanted: Form, form: Form): Response {
    const item = sub.items.data.find((i) => i.id === wanted.id);
    const to = priceById(wanted.price);

    if (!item || !to) {
      return stripeError(400, 'bad item');
    }

    const quantity = Number(wanted.quantity ?? item.quantity ?? 1);
    const at =
      form.proration_date === undefined ? now : Number(form.proration_date);
    const total = prorate(item, to, { at, quantity });

    if (typeof total === 'string') {
      return stripeError(400, total);
    }

    state.prorations.push({ subscription: sub.id, at, total });

    if (
      declines &&
      form.payment_behavior === 'pending_if_incomplete' &&
      due(sub.customer, total) > 0
    ) {
      sub.pending_update = {
        expires_at: now + 23 * 3600,
        subscription_items: [wanted],
      };
      sub.latest_invoice = nextId('in');

      return json(sub);
    }

    item.price = to;
    item.quantity = quantity;

    return json({ ...sub, pending_update: null });
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
    scheduled?.(s);

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

  /** Every object in a response gets `livemode`, when the fake is told which mode it's in. */
  function stamp(r: Response): Response {
    const mode = o.livemode ?? false;

    if (r.status >= 400) {
      return r;
    }

    const body = JSON.parse(syncText.get(r) ?? '{}') as Form;
    const items = Array.isArray(body.data) ? (body.data as Form[]) : [body];

    for (const x of items) {
      x.livemode = mode;
    }

    return json(body, r.status);
  }

  /** Replays a key's saved response, as Stripe does for 24 hours, except on DELETE, which it ignores keys on. */
  async function respond(
    u: URL,
    method: string,
    body: string,
    header: string | null,
  ) {
    const key = method === 'DELETE' ? null : header;
    const saved = key ? replays.get(key) : undefined;

    if (saved) {
      return new Response(saved.body, { status: saved.status });
    }

    const r = stamp(route(u, method, body));

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

    // A request option sent as a parameter by mistake: Stripe refuses what it doesn't know.
    if (`${u.search}&${body}`.includes('idempotencyKey')) {
      return stripeError(
        400,
        'Received unknown parameter: idempotencyKey',
        'parameter_unknown',
      );
    }

    const f = failureFor(method, path);

    if (f) {
      f.times = (f.times ?? 1) - 1;

      if (f.after) {
        await respond(u, method, body, key);
      }

      if (f.network || f.after) {
        throw Object.assign(new TypeError('fetch failed'), { code: f.code });
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
    /** Change each schedule the fake makes, as Stripe might. */
    onSchedule: (f: (s: Schedule) => void) => {
      scheduled = f;
    },
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
