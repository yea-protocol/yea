import { describe, expect, it } from 'vitest';
import {
  currentSubscription,
  currentSubscriptions,
  encodeForm,
  findCustomers,
  isLiveKey,
  redactKeys,
  STRIPE_VERSION,
  StripeError,
  stripeApi,
} from '../src/api.js';
import { fakeStripe, price, subscription } from './fake-stripe.js';
import { D, NOW, TEST_KEY } from './helpers.js';

const client = (
  f = fakeStripe({ now: NOW }),
  o: { newKey?: () => string } = {},
) => ({
  f,
  api: stripeApi({
    key: TEST_KEY,
    fetch: f.fetch,
    sleep: async () => {},
    ...o,
  }),
});

describe('the Stripe client', () => {
  it('pins the API version and sends the key only as a bearer token, on every request', async () => {
    const { f, api } = client();

    await api.get('/customers/cus_chen');
    await api.preview('/invoices/create_preview', {
      subscription: 'sub_chen',
      subscription_details: {
        items: [{ id: 'si_chen', price: 'price_basic', quantity: 1 }],
        proration_date: NOW - 3600,
      },
    });
    await api.write('POST', '/subscriptions/sub_chen', {
      cancel_at_period_end: true,
    });
    await api.write('DELETE', '/subscriptions/sub_chen');

    expect(f.calls).toHaveLength(4);

    for (const c of f.calls) {
      expect(c.version).toBe(STRIPE_VERSION);
      expect(STRIPE_VERSION).toBe('2026-08-26.dahlia');
      expect(c.auth).toBe(`Bearer ${TEST_KEY}`);
      expect(c.path).not.toContain(TEST_KEY);
      expect(c.body).not.toContain(TEST_KEY);
    }
  });

  it('sends an idempotency key with writes only, fresh for every call', async () => {
    const { f, api } = client();

    await api.get('/customers/cus_chen');
    await api.preview('/invoices/create_preview', {}).catch(() => null);
    await api.write('POST', '/refunds', {
      payment_intent: 'pi_2',
      amount: 100,
    });
    await api.write('POST', '/refunds', {
      payment_intent: 'pi_2',
      amount: 100,
    });

    const [get, preview, one, two] = f.calls;

    expect(get.key).toBeNull();
    expect(preview.key).toBeNull();
    expect(one.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(two.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(one.key).not.toBe(two.key);
    // Two identical writes are two refunds, not a replay.
    expect(f.charges[0].amount_refunded).toBe(200);
  });

  it('reuses the key only for its own network retries', async () => {
    const { f, api } = client();

    f.fail({ path: '/refunds', network: true, times: 2 });
    await api.write('POST', '/refunds', {
      payment_intent: 'pi_2',
      amount: 100,
    });

    const keys = f.calls.map((c) => c.key);

    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(f.state.refunds).toHaveLength(1);
  });

  it('a lost response is retried with the same key, and Stripe replays it instead of refunding twice', async () => {
    const { f, api } = client();

    f.fail({ path: '/refunds', after: true });

    const r = await api.write<{ id: string }>('POST', '/refunds', {
      payment_intent: 'pi_2',
      amount: 100,
    });

    expect(r.id).toBe('re_1');
    expect(f.calls).toHaveLength(2);
    expect(f.state.refunds).toHaveLength(1);
    expect(f.charges[0].amount_refunded).toBe(100);
  });

  it('a write with no answer after every try may have happened, and says so', async () => {
    const { f, api } = client();

    f.fail({ path: '/refunds', network: true, times: 3 });

    const e = await api
      .write('POST', '/refunds', { payment_intent: 'pi_2', amount: 100 })
      .catch((x: unknown) => x);

    expect(e).toBeInstanceOf(StripeError);
    expect((e as StripeError).unknown).toBe(true);
    expect((e as StripeError).message).toMatch(
      /may have happened; check the Stripe dashboard/,
    );
  });

  it('a read with no answer is just a failure', async () => {
    const { f, api } = client();

    f.fail({ path: '/customers/cus_chen', network: true, times: 3 });

    const e = (await api
      .get('/customers/cus_chen')
      .catch((x: unknown) => x)) as StripeError;

    expect(e.unknown).toBe(false);
    expect(e.message).toMatch(/no answer from Stripe .*; try again shortly/);
  });

  it('retries a 429 and a 5xx; a 5xx on a write that persists may have happened', async () => {
    const { f, api } = client();

    f.fail({ path: '/customers/cus_chen', status: 429 });
    expect(await api.get('/customers/cus_chen')).toMatchObject({
      id: 'cus_chen',
    });

    f.fail({ path: '/refunds', status: 500, times: 3 });

    const e = (await api
      .write('POST', '/refunds', { payment_intent: 'pi_2', amount: 1 })
      .catch((x: unknown) => x)) as StripeError;

    expect(e.unknown).toBe(true);
    expect(e.message).toMatch(/the write may have happened/);
  });

  it('a 4xx is not retried and changed nothing', async () => {
    const { f, api } = client();
    const e = (await api
      .write('POST', '/refunds', { payment_intent: 'pi_2', amount: 999999 })
      .catch((x: unknown) => x)) as StripeError;

    expect(f.calls).toHaveLength(1);
    expect(e.status).toBe(400);
    expect(e.unknown).toBe(false);
    expect(e.message).toBe(
      'Stripe: Refund amount is greater than unrefunded amount',
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
      .write('POST', '/refunds', { payment_intent: 'pi_2', amount: 1 })
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

  it('encodes nested forms the way Stripe reads them', () => {
    expect(
      decodeURIComponent(
        encodeForm({
          a: 1,
          skip: undefined,
          none: null,
          phases: [
            {
              items: [{ price: 'p', quantity: 2 }],
              duration: { interval: 'month' },
            },
          ],
          flag: false,
        }),
      ),
    ).toBe(
      'a=1&phases[0][items][0][price]=p&phases[0][items][0][quantity]=2&phases[0][duration][interval]=month&flag=false',
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
    expect(f.calls[0].path).toBe(
      `/v1/customers/search?${new URLSearchParams({ query: 'name:"Ana" OR email:"Ana"', limit: '5' })}`,
    );
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

    expect(await client(f).api.get('/customers/cus_chen')).toMatchObject({
      livemode: false,
    });
  });

  it('a test key answered in live mode fails closed, on reads and lists', async () => {
    const { api } = client(fakeStripe({ now: NOW, livemode: true }));

    await expect(api.get('/customers/cus_chen')).rejects.toThrow(
      /Stripe answered in live mode, but the key looks like a test key; refusing to go on$/,
    );
    await expect(findCustomers(api, 'Ana')).rejects.toThrow(
      /answered in live mode/,
    );
  });

  it('a write answered in the other mode may have happened, and says so', async () => {
    const f = fakeStripe({ now: NOW, livemode: false });
    const api = stripeApi({
      key: 'sk_live_51abc',
      fetch: f.fetch,
      sleep: async () => {},
    });
    const e = (await api
      .write('POST', '/subscriptions/sub_chen', { cancel_at_period_end: true })
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
  const api = stripeApi({ key, fetch: f.fetch, sleep: async () => {} });

  f.fail({
    path: '/customers/cus_chen',
    status: 400,
    message: `bad key ${key} here`,
  });

  const e = (await api
    .get('/customers/cus_chen')
    .catch((x: unknown) => x)) as Error;

  expect(e.message).toBe('Stripe: bad key … here');
});
