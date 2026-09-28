import { describe, expect, it } from 'vitest';
import {
  currentSubscription,
  currentSubscriptions,
  findCustomers,
  isLiveKey,
  redactKeys,
  STRIPE_VERSION,
  StripeError,
  stripeApi,
  subscriptionPage,
} from '../src/api.js';
import { cancelJob } from '../src/cancel.js';
import { refundJob } from '../src/refund.js';
import { fakeStripe, price, subscription } from './fake-stripe.js';
import { D, NOW, plansOf, setup, TEST_KEY } from './helpers.js';

const client = (f = fakeStripe({ now: NOW })) => ({
  f,
  api: stripeApi({ key: TEST_KEY, fetch: f.fetch }),
});

const refund = { payment_intent: 'pi_2', amount: 100 };

describe('the Stripe client', () => {
  it('pins the API version and sends the key only as a bearer token, on every request', async () => {
    const { f, api } = client();

    await api.read((s) => s.customers.retrieve('cus_chen'));
    await api.read((s) =>
      s.invoices.createPreview({
        subscription: 'sub_chen',
        subscription_details: {
          items: [{ id: 'si_chen', price: 'price_basic', quantity: 1 }],
          proration_date: NOW - 3600,
        },
      }),
    );
    await api.write((s, o) =>
      s.subscriptions.update('sub_chen', { cancel_at_period_end: true }, o),
    );
    await api.write((s, o) => s.subscriptions.cancel('sub_chen', {}, o));

    expect(f.calls.map((c) => c.method)).toEqual([
      'GET',
      'POST',
      'POST',
      'DELETE',
    ]);
    expect(STRIPE_VERSION).toBe('2026-08-26.dahlia');

    for (const c of f.calls) {
      expect(c.version).toBe(STRIPE_VERSION);
      expect(c.auth).toBe(`Bearer ${TEST_KEY}`);
      expect(c.path).not.toContain(TEST_KEY);
      expect(c.body).not.toContain(TEST_KEY);
    }
  });

  it('sends each write a fresh random idempotency key, DELETE included, and reads none', async () => {
    const { f, api } = client();

    await api.read((s) => s.customers.retrieve('cus_chen'));
    await api.write((s, o) => s.refunds.create(refund, o));
    await api.write((s, o) => s.refunds.create(refund, o));
    await api.write((s, o) => s.subscriptions.cancel('sub_chen', {}, o));

    const [get, ...writes] = f.calls;
    const keys = writes.map((c) => c.key);

    expect(get.key).toBeNull();

    for (const key of keys) {
      expect(key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }

    expect(new Set(keys).size).toBe(3);
    // Two identical writes are two refunds, not a replay.
    expect(f.charges[0].amount_refunded).toBe(200);
  });

  it('reuses the key only for its own network retries', async () => {
    const { f, api } = client();

    f.fail({ path: '/refunds', network: true, times: 2 });
    await api.write((s, o) => s.refunds.create(refund, o));

    const keys = f.calls.map((c) => c.key);

    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(f.state.refunds).toHaveLength(1);
  });

  it('a lost response is retried with the same key, and Stripe replays it instead of refunding twice', async () => {
    const { f, api } = client();

    f.fail({ path: '/refunds', after: true });

    const r = await api.write((s, o) => s.refunds.create(refund, o));

    expect(r.id).toBe('re_1');
    expect(f.calls).toHaveLength(2);
    expect(f.state.refunds).toHaveLength(1);
    expect(f.charges[0].amount_refunded).toBe(100);
  });

  it('a write with no answer after every try may have happened, and says so', async () => {
    const { f, api } = client();

    f.fail({ path: '/refunds', network: true, times: 3 });

    const e = await api
      .write((s, o) => s.refunds.create(refund, o))
      .catch((x: unknown) => x);

    expect(f.calls).toHaveLength(3);
    expect(e).toBeInstanceOf(StripeError);
    expect((e as StripeError).unknown).toBe(true);
    expect((e as StripeError).status).toBe(0);
    expect((e as StripeError).message).toMatch(
      /^no answer from Stripe \(.+\), so the write may have happened; check the Stripe dashboard/,
    );
  });

  it('a read with no answer is just a failure', async () => {
    const { f, api } = client();

    f.fail({ path: '/customers/cus_chen', network: true, times: 3 });

    const e = (await api
      .read((s) => s.customers.retrieve('cus_chen'))
      .catch((x: unknown) => x)) as StripeError;

    expect(e.unknown).toBe(false);
    expect(e.message).toMatch(/no answer from Stripe .*; try again shortly/);
  });

  it('retries a 5xx; a 5xx on a write that persists may have happened', async () => {
    const { f, api } = client();

    f.fail({ path: '/customers/cus_chen', status: 500 });
    expect(
      await api.read((s) => s.customers.retrieve('cus_chen')),
    ).toMatchObject({ id: 'cus_chen' });

    f.fail({ path: '/refunds', status: 500, times: 3 });

    const e = (await api
      .write((s, o) => s.refunds.create({ ...refund, amount: 1 }, o))
      .catch((x: unknown) => x)) as StripeError;

    expect(e.status).toBe(500);
    expect(e.unknown).toBe(true);
    expect(e.message).toMatch(/the write may have happened/);
  });

  it('a rate limit says to try again, and changed nothing', async () => {
    const { f, api } = client();

    f.fail({ path: '/refunds', status: 429 });

    const e = (await api
      .write((s, o) => s.refunds.create(refund, o))
      .catch((x: unknown) => x)) as StripeError;

    expect(e.status).toBe(429);
    expect(e.unknown).toBe(false);
    expect(e.message).toBe('Stripe is rate limiting; try again shortly');
  });

  it('a 4xx is not retried and changed nothing', async () => {
    const { f, api } = client();
    const e = (await api
      .write((s, o) => s.refunds.create({ ...refund, amount: 999999 }, o))
      .catch((x: unknown) => x)) as StripeError;

    expect(f.calls).toHaveLength(1);
    expect(e.status).toBe(400);
    expect(e.code).toBe('amount_too_large');
    expect(e.unknown).toBe(false);
    expect(e.message).toBe(
      'Stripe: Refund amount is greater than unrefunded amount',
    );
  });

  it('a rejected key says to check the key file', async () => {
    const { f, api } = client();

    f.fail({
      path: '/customers/cus_chen',
      status: 401,
      message: 'Invalid API Key provided: sk_test_****DEF',
    });

    await expect(
      api.read((s) => s.customers.retrieve('cus_chen')),
    ).rejects.toThrow(
      'Stripe rejected the key (Invalid API Key provided: sk_test_…); check STRIPE_SECRET_KEY_FILE',
    );
  });

  it('a permission error says the key lacks a permission, without repeating the key', async () => {
    const { f, api } = client();

    f.fail({
      path: '/refunds',
      status: 403,
      message:
        "The provided key 'rk_test_51abc***xyz' does not have the required permissions for this endpoint. Having the 'rak_charge_write' permission would allow this request to continue.",
    });

    const e = (await api
      .write((s, o) => s.refunds.create(refund, o))
      .catch((x: unknown) => x)) as StripeError;

    expect(e.permission).toBe(true);
    expect(e.unknown).toBe(false);
    expect(e.message).toMatch(/^the Stripe key lacks a permission this needs/);
    expect(e.message).toContain('rak_charge_write');
    expect(e.message).toContain("'rk_test_…'");
    expect(e.message).not.toContain('51abc');
  });

  it('redacts anything that looks like a key', () => {
    expect(redactKeys('bad key sk_live_51Habc and rk_test_9z')).toBe(
      'bad key sk_live_… and rk_test_…',
    );
  });
});

describe('live mode', () => {
  it('is any key without _test_, so an unknown format counts as live', () => {
    expect(isLiveKey('sk_live_abc')).toBe(true);
    expect(isLiveKey('rk_live_abc')).toBe(true);
    expect(isLiveKey('sk_test_abc')).toBe(false);
    expect(isLiveKey('rk_test_abc')).toBe(false);
    expect(isLiveKey('whatever')).toBe(true);
    expect(isLiveKey('sk_TEST_abc')).toBe(true);
  });
});

describe('finding customers', () => {
  it('looks an exact email up with the list call, which has no indexing delay, not search', async () => {
    const { f, api } = client();
    const found = await findCustomers(api, 'ana@northwind.io');

    expect(found.map((c) => c.id)).toEqual(['cus_ana2']);
    expect(f.calls.map((c) => c.path)).toEqual([
      '/v1/customers?email=ana%40northwind.io&limit=5',
    ]);
  });

  it('an id is fetched; a deleted or missing one is no match', async () => {
    const { f, api } = client();

    expect((await findCustomers(api, 'cus_chen')).map((c) => c.id)).toEqual([
      'cus_chen',
    ]);
    expect(await findCustomers(api, 'cus_nope')).toEqual([]);

    f.state.customers.push({
      id: 'cus_gone',
      name: null,
      email: null,
      deleted: true,
    });
    expect(await findCustomers(api, 'cus_gone')).toEqual([]);
  });

  it('a name is searched, at most 5', async () => {
    const { f, api } = client();

    expect((await findCustomers(api, 'Ana')).map((c) => c.id)).toEqual([
      'cus_ana1',
      'cus_ana2',
    ]);

    const u = new URL(f.calls[0].path, 'https://api.stripe.com');

    expect(u.pathname).toBe('/v1/customers/search');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      query: 'name:"Ana" OR email:"Ana"',
      limit: '5',
    });
  });
});

describe('reading subscriptions', () => {
  const sub = (id: string, status: string) =>
    subscription(id, 'cus_chen', price('price_pro', 4900), {
      start: NOW - D,
      end: NOW + 29 * D,
      status,
    });

  it('newer cancelled subscriptions can’t hide an active one', async () => {
    const f = fakeStripe({
      now: NOW,
      state: (b) => ({
        subs: [
          ...b.subs,
          ...Array.from({ length: 12 }, (_, i) =>
            sub(`sub_old${i}`, 'canceled'),
          ),
        ],
      }),
    });
    const { api } = client(f);

    expect(
      (await currentSubscriptions(api, 'cus_chen')).map((s) => s.id),
    ).toEqual(['sub_chen']);
    expect(f.calls[0].path).toBe(
      '/v1/subscriptions?customer=cus_chen&limit=100',
    );
  });

  it('more than a page of them is refused, not read in part', async () => {
    const f = fakeStripe({
      now: NOW,
      state: () => ({
        subs: Array.from({ length: 101 }, (_, i) => sub(`sub_${i}`, 'active')),
      }),
    });

    await expect(
      currentSubscriptions(client(f).api, 'cus_chen'),
    ).rejects.toThrow(
      'cus_chen has more than 100 subscriptions; pass the sub_ id of the one you mean',
    );

    // Only jobs that act on a subscription refuse; a refund and the customer tool read the page.
    const s = setup({
      state: (b) => ({
        subs: Array.from({ length: 101 }, (_, i) =>
          sub(`sub_${i}`, 'active'),
        ).concat(b.subs),
      }),
    });

    expect(await plansOf(refundJob(s.ctx), { customer: 'Chen' })).toHaveLength(
      2,
    );
    await expect(cancelJob(s.ctx).plan({ customer: 'Chen' })).rejects.toThrow(
      /more than 100 subscriptions/,
    );
    expect((await subscriptionPage(client(f).api, 'cus_chen')).more).toBe(true);
  });

  it('one named by id is fetched, and must be the customer’s and in force', async () => {
    const f = fakeStripe({
      now: NOW,
      state: (b) => ({ subs: [...b.subs, sub('sub_gone', 'canceled')] }),
    });
    const { api } = client(f);

    expect((await currentSubscription(api, 'cus_chen', 'sub_chen'))?.id).toBe(
      'sub_chen',
    );
    expect(await currentSubscription(api, 'cus_ana1', 'sub_chen')).toBeNull();
    expect(await currentSubscription(api, 'cus_chen', 'sub_gone')).toBeNull();
    expect(await currentSubscription(api, 'cus_chen', 'sub_nope')).toBeNull();
    expect(await currentSubscription(api, 'cus_chen', '../refunds')).toBeNull();
  });
});

describe('the mode Stripe answers in', () => {
  it('a test key answered in test mode is fine', async () => {
    const f = fakeStripe({ now: NOW, livemode: false });

    expect(
      await client(f).api.read((s) => s.customers.retrieve('cus_chen')),
    ).toMatchObject({ livemode: false });
  });

  it('a test key answered in live mode fails closed, on reads and lists', async () => {
    const { api } = client(fakeStripe({ now: NOW, livemode: true }));

    await expect(
      api.read((s) => s.customers.retrieve('cus_chen')),
    ).rejects.toThrow(
      /Stripe answered in live mode, but the key looks like a test key; refusing to go on$/,
    );
    await expect(findCustomers(api, 'Ana')).rejects.toThrow(
      /answered in live mode/,
    );
  });

  it('a write answered in the other mode may have happened, and says so', async () => {
    const f = fakeStripe({ now: NOW, livemode: false });
    const api = stripeApi({ key: 'sk_live_51abc', fetch: f.fetch });
    const e = (await api
      .write((s, o) =>
        s.subscriptions.update('sub_chen', { cancel_at_period_end: true }, o),
      )
      .catch((x: unknown) => x)) as StripeError;

    expect(e.unknown).toBe(true);
    expect(e.message).toMatch(
      /answered in test mode.*The write may have happened/,
    );
  });
});

it('the key itself is taken out of any message, whatever its format', async () => {
  const f = fakeStripe({ now: NOW });
  const key = 'weird0key0format0123';
  const api = stripeApi({ key, fetch: f.fetch });

  f.fail({
    path: '/customers/cus_chen',
    status: 400,
    message: `bad key ${key} here`,
  });

  const e = (await api
    .read((s) => s.customers.retrieve('cus_chen'))
    .catch((x: unknown) => x)) as Error;

  expect(e.message).toBe('Stripe: bad key … here');
});

it('a customer without livemode fails closed: its mode can’t be checked', async () => {
  const f = fakeStripe({ now: NOW });
  const { api } = client(f);
  const plain = (c: object) => new Response(JSON.stringify(c), { status: 200 });
  const bare = stripeApi({
    key: TEST_KEY,
    fetch: async (url, init) =>
      String(url).includes('/customers/cus_chen')
        ? plain({ id: 'cus_chen', name: 'Chen Wei', email: null })
        : f.fetch(url, init),
  });

  expect((await findCustomers(api, 'cus_chen'))[0]).toMatchObject({
    livemode: false,
  });
  await expect(findCustomers(bare, 'cus_chen')).rejects.toThrow(
    /came back without livemode, so its mode can't be checked/,
  );
});
