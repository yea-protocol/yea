/**
 * The Stripe REST API, as this connector uses it: one client that pins the API version, sends
 * a fresh idempotency key with each write, retries its own network failures, and turns Stripe's
 * errors into a `StripeError` that says what to do. Plus the readers (customers, charges,
 * subscriptions) that `examples/stripe-billing.ts` shares. No dependencies, so the example can
 * import it without the MCP server.
 */

export const API = 'https://api.stripe.com/v1';

/** The version this connector is tested against. Periods live on subscription items since basil. */
export const STRIPE_VERSION = '2026-08-26.dahlia';

/** A form value: Stripe's `a[b][0][c]=…` encoding flattens nested objects and arrays. */
export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FormValue[]
  | { [k: string]: FormValue };

export interface StripeOptions {
  /** A secret (`sk_…`) or restricted (`rk_…`) key. */
  key: string;
  fetch?: typeof fetch;
  /** Tries per request, counting the first. Default 3. */
  attempts?: number;
  /** How long to wait between tries. Default: 500 ms, then 1 s. */
  sleep?: (ms: number) => Promise<void>;
  /** A new idempotency key. Default `crypto.randomUUID()`. */
  newKey?: () => string;
  /** Per-try timeout in ms. Default 30 000. */
  timeoutMs?: number;
}

/** Why a Stripe request failed, in words an agent can act on. */
export class StripeError extends Error {
  /** The HTTP status; 0 when no response came back. */
  readonly status: number;
  /** Stripe's error `code`, when it gave one. */
  readonly code: string | undefined;
  /** A write whose result is unknown: it may have happened. */
  readonly unknown: boolean;
  /** The key lacks a permission this request needs. */
  readonly permission: boolean;

  constructor(
    message: string,
    o: { status: number; code?: string; unknown?: boolean },
  ) {
    super(message);
    this.name = 'StripeError';
    this.status = o.status;
    this.code = o.code;
    this.unknown = o.unknown ?? false;
    this.permission = o.status === 403;
  }
}

/** The client: reads, a POST that writes nothing, and writes. */
export interface Stripe {
  /** `GET path?query`. */
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
  /** A POST that changes nothing, such as `/invoices/create_preview`: no idempotency key. */
  preview<T>(path: string, form: Record<string, FormValue>): Promise<T>;
  /**
   * A write, with a fresh random idempotency key that only this call's own retries reuse. A
   * second call is a second write, never a replay of the first.
   */
  write<T>(
    method: 'POST' | 'DELETE',
    path: string,
    form?: Record<string, FormValue>,
  ): Promise<T>;
}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Stripe's form encoding: nested objects and arrays become `a[b][0]` keys; null and undefined are left out. */
export function encodeForm(form: Record<string, FormValue>): string {
  const out = new URLSearchParams();
  const add = (key: string, v: FormValue) => {
    if (v === null || v === undefined) {
      return;
    }

    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        add(`${key}[${i}]`, x);
      });
    } else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        add(`${key}[${k}]`, x);
      }
    } else {
      out.append(key, String(v));
    }
  };

  for (const [k, v] of Object.entries(form)) {
    add(k, v);
  }

  return out.toString();
}

/** Keys never appear in messages: Stripe masks them, and this makes sure. */
export const redactKeys = (s: string) =>
  s.replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g, '$1_$2_…');

/** A key is live unless it says it's a test key, so an unknown format fails toward caution. */
export const isLiveKey = (key: string) => !key.includes('_test_');

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

interface Attempt {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  body?: string;
  idempotencyKey?: string;
}

/** What one try came back with: a response, or no response at all. */
type Outcome =
  | { kind: 'response'; status: number; json: unknown; retry: boolean }
  | { kind: 'network'; message: string };

/** Whether Stripe asks us to retry: 429, 5xx, or a key still in use, unless it says not to. */
function retryable(res: Response, json: unknown): boolean {
  const header = res.headers.get('stripe-should-retry');

  if (header !== null) {
    return header === 'true';
  }

  const code = isObject(json) && isObject(json.error) ? json.error.code : null;

  return (
    res.status === 429 ||
    res.status >= 500 ||
    (res.status === 409 && code === 'idempotency_key_in_use')
  );
}

/** The message Stripe gave, else the status. */
function stripeMessage(json: unknown, status: number): string {
  const e = isObject(json) && isObject(json.error) ? json.error : {};

  return typeof e.message === 'string' && e.message
    ? e.message
    : `Stripe returned HTTP ${status}`;
}

const stripeCode = (json: unknown): string | undefined => {
  const e = isObject(json) && isObject(json.error) ? json.error : {};

  return typeof e.code === 'string' ? e.code : undefined;
};

/** Stripe's error, said so an agent knows what to do next. */
function teach(
  status: number,
  json: unknown,
  o: { write: boolean; clean: (s: string) => string },
): StripeError {
  const said = o.clean(stripeMessage(json, status));
  const write = o.write;
  const code = stripeCode(json);

  if (status === 403) {
    return new StripeError(
      `the Stripe key lacks a permission this needs (Stripe says: ${said}). Add that permission to the restricted key, then try again`,
      { status, code },
    );
  }

  if (status === 401) {
    return new StripeError(
      `Stripe rejected the key (${said}); check STRIPE_SECRET_KEY_FILE`,
      { status, code },
    );
  }

  if (status === 429) {
    return new StripeError('Stripe is rate limiting; try again shortly', {
      status,
      code,
    });
  }

  // A 5xx on a write may have been applied before it failed.
  const unknown = write && status >= 500;

  return new StripeError(
    unknown
      ? `Stripe failed (${said}), and the write may have happened; check the Stripe dashboard before trying again`
      : `Stripe: ${said}`,
    { status, code, unknown },
  );
}

/** One try: a response, or a network failure (including a timeout). */
async function tryOnce(
  f: typeof fetch,
  a: Attempt,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Outcome> {
  try {
    const res = await f(a.url, {
      method: a.method,
      headers: {
        ...headers,
        ...(a.body === undefined
          ? {}
          : { 'content-type': 'application/x-www-form-urlencoded' }),
        ...(a.idempotencyKey ? { 'idempotency-key': a.idempotencyKey } : {}),
      },
      ...(a.body === undefined ? {} : { body: a.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json: unknown = await res.json().catch(() => null);

    return {
      kind: 'response',
      status: res.status,
      json,
      retry: !res.ok && retryable(res, json),
    };
  } catch (e) {
    return {
      kind: 'network',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Every object in a response that says which mode it's in. */
function modesIn(json: unknown): boolean[] {
  if (!isObject(json)) {
    return [];
  }

  const items = Array.isArray(json.data) ? json.data : [json];

  return items.flatMap((x) =>
    isObject(x) && typeof x.livemode === 'boolean' ? [x.livemode] : [],
  );
}

interface Settling {
  write: boolean;
  /** Whether the key looks live. */
  live: boolean;
  /** Takes the key, and anything like one, out of a message. */
  clean(s: string): string;
}

/**
 * A response from the other mode than the key looks like fails closed: the `[test]` or `[LIVE]`
 * a person approved would be wrong.
 */
function checkMode(json: unknown, o: Settling) {
  if (modesIn(json).some((m) => m !== o.live)) {
    throw new StripeError(
      `Stripe answered in ${o.live ? 'test' : 'live'} mode, but the key looks like a ${o.live ? 'live' : 'test'} key; refusing to go on${o.write ? '. The write may have happened: check the Stripe dashboard' : ''}`,
      { status: 0, unknown: o.write },
    );
  }
}

/** The final outcome as a value, or the error that says what to do. */
function settle<T>(last: Outcome, o: Settling): T {
  if (last.kind === 'network') {
    const why = o.clean(last.message);

    throw new StripeError(
      o.write
        ? `no answer from Stripe (${why}), so the write may have happened; check the Stripe dashboard before trying again`
        : `no answer from Stripe (${why}); try again shortly`,
      { status: 0, unknown: o.write },
    );
  }

  if (last.status >= 200 && last.status < 300) {
    checkMode(last.json, o);

    return last.json as T;
  }

  throw teach(last.status, last.json, o);
}

/** Create the client. The key is only ever sent to Stripe, in the Authorization header. */
export function stripeApi(o: StripeOptions): Stripe {
  const f = o.fetch ?? globalThis.fetch;
  const attempts = Math.max(1, o.attempts ?? 3);
  const sleep = o.sleep ?? defaultSleep;
  const newKey = o.newKey ?? (() => globalThis.crypto.randomUUID());
  const timeoutMs = o.timeoutMs ?? 30_000;
  const headers = {
    authorization: `Bearer ${o.key}`,
    'stripe-version': STRIPE_VERSION,
  };

  /** Try up to `attempts` times, with the same key, until Stripe answers something final. */
  const tryAll = async (a: Attempt): Promise<Outcome> => {
    let last: Outcome = { kind: 'network', message: 'not sent' };

    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        await sleep(500 * i);
      }

      last = await tryOnce(f, a, headers, timeoutMs);

      if (last.kind === 'response' && !last.retry) {
        break;
      }
    }

    return last;
  };

  const live = isLiveKey(o.key);
  const clean = (text: string) =>
    o.key ? redactKeys(text).split(o.key).join('…') : redactKeys(text);
  const send = async <T>(a: Attempt): Promise<T> =>
    settle<T>(await tryAll(a), {
      write: a.idempotencyKey !== undefined,
      live,
      clean,
    });

  return {
    get: (path, query) =>
      send({
        method: 'GET',
        url: `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`,
      }),
    preview: (path, form) =>
      send({ method: 'POST', url: API + path, body: encodeForm(form) }),
    write: (method, path, form) =>
      send({
        method,
        url: API + path,
        idempotencyKey: newKey(),
        ...(form ? { body: encodeForm(form) } : {}),
      }),
  };
}

// ---- The objects this connector reads, and only the fields it reads. ----

export interface Customer {
  id: string;
  name: string | null;
  email: string | null;
  deleted?: boolean;
}

export interface Charge {
  id: string;
  created: number;
  amount: number;
  amount_refunded: number;
  currency: string;
  status: string;
  refunded?: boolean;
  payment_intent: string | null;
}

export interface Price {
  id: string;
  active?: boolean;
  nickname: string | null;
  currency: string;
  unit_amount: number | null;
  billing_scheme?: 'per_unit' | 'tiered';
  lookup_key?: string | null;
  transform_quantity?: unknown;
  recurring: {
    interval: string;
    interval_count: number;
    usage_type?: 'licensed' | 'metered';
  } | null;
}

export interface SubscriptionItem {
  id: string;
  quantity?: number;
  current_period_start: number;
  current_period_end: number;
  price: Price;
  discounts?: unknown[];
}

export interface Subscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  /** Set when the subscription is due to cancel at a given time. */
  cancel_at?: number | null;
  schedule: string | null;
  discounts?: unknown[];
  items: { data: SubscriptionItem[] };
}

export interface List<T> {
  data: T[];
  has_more?: boolean;
}

/** The first item's billing period (since API version 2025-03-31, it's on the item). */
export function period(s: Subscription): { start: number; end: number } {
  const item = s.items.data[0];

  if (!item) {
    throw new StripeError(`${s.id} has no items`, { status: 0 });
  }

  return { start: item.current_period_start, end: item.current_period_end };
}

const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** One customer by id; a deleted one counts as missing. */
export async function retrieveCustomer(
  s: Stripe,
  id: string,
): Promise<Customer | null> {
  try {
    const c = await s.get<Customer>(`/customers/${id}`);

    return c.deleted ? null : c;
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) {
      return null;
    }

    throw e;
  }
}

/**
 * Customers matching what a person said, at most `limit`: an id, an exact email (a list call,
 * which has no indexing delay), or else Stripe's search on name and email, which is eventually
 * consistent.
 */
export async function findCustomers(
  s: Stripe,
  who: string,
  limit = 5,
): Promise<Customer[]> {
  const text = who.trim();

  if (CUSTOMER_ID.test(text)) {
    const c = await retrieveCustomer(s, text);

    return c ? [c] : [];
  }

  if (EMAIL.test(text)) {
    const byEmail = await s.get<List<Customer>>('/customers', {
      email: text,
      limit: String(limit),
    });

    return byEmail.data;
  }

  // Stripe wants double-quoted, backslash-escaped strings.
  const q = JSON.stringify(text);
  const found = await s.get<List<Customer>>('/customers/search', {
    query: `name:${q} OR email:${q}`,
    limit: String(limit),
  });

  return found.data;
}

/** A customer's most recent charges, newest first. */
export async function recentCharges(
  s: Stripe,
  customer: string,
  limit = 10,
): Promise<Charge[]> {
  return (
    await s.get<List<Charge>>('/charges', {
      customer,
      limit: String(limit),
    })
  ).data;
}

/** Subscriptions still in force: active, trialing or past due. */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** The most subscriptions one customer's list reads. */
const MAX_SUBSCRIPTIONS = 100;

/**
 * A customer's subscriptions that are still in force. Stripe's default list leaves out
 * cancelled ones, so they can't hide a live one; a list that doesn't fit in one page is refused
 * rather than read in part.
 */
export async function currentSubscriptions(
  s: Stripe,
  customer: string,
): Promise<Subscription[]> {
  const all = await s.get<List<Subscription>>('/subscriptions', {
    customer,
    limit: String(MAX_SUBSCRIPTIONS),
  });

  if (all.has_more) {
    throw new StripeError(
      `${customer} has more than ${MAX_SUBSCRIPTIONS} subscriptions; pass the sub_ id of the one you mean`,
      { status: 0 },
    );
  }

  return all.data.filter((x) => LIVE_STATUSES.has(x.status));
}

/** One subscription by id, if it's this customer's and still in force. */
export async function currentSubscription(
  s: Stripe,
  customer: string,
  id: string,
): Promise<Subscription | null> {
  if (!/^sub_[A-Za-z0-9]+$/.test(id)) {
    return null;
  }

  try {
    const sub = await s.get<Subscription>(`/subscriptions/${id}`);

    return sub.customer === customer && LIVE_STATUSES.has(sub.status)
      ? sub
      : null;
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) {
      return null;
    }

    throw e;
  }
}
