import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  parseMoney,
  roundDown,
  scaleOf,
  stepOf,
  toQuantity,
} from '../src/currency.js';
import { refundJob } from '../src/refund.js';
import { fakeStripe } from './fake-stripe.js';
import { D, NOW, plansOf, setup } from './helpers.js';

describe('currencies, by Stripe’s rules', () => {
  it('two decimals by default', () => {
    expect(scaleOf('usd')).toBe(2);
    expect(toQuantity(1250, 'usd')).toEqual({
      amount: 1250,
      scale: 2,
      unit: 'USD',
    });
    expect(formatMoney(1250, 'usd')).toBe('12.50 USD');
    expect(parseMoney('12.50', 'usd')).toBe(1250);
    expect(parseMoney('12.5', 'usd')).toBe(1250);
    expect(parseMoney('12', 'eur')).toBe(1200);
  });

  it.each([
    'BIF',
    'CLP',
    'DJF',
    'GNF',
    'JPY',
    'KMF',
    'KRW',
    'MGA',
    'PYG',
    'RWF',
    'UGX',
    'VND',
    'VUV',
    'XAF',
    'XOF',
    'XPF',
  ])('%s is zero-decimal', (c) => {
    expect(scaleOf(c.toLowerCase())).toBe(0);
    expect(() => parseMoney('5.5', c)).toThrow(/at most 0 decimals/);
  });

  it('JPY: the API amount is the amount', () => {
    expect(toQuantity(500, 'jpy')).toEqual({ amount: 500, unit: 'JPY' });
    expect(formatMoney(500, 'jpy')).toBe('500 JPY');
    expect(parseMoney('500', 'jpy')).toBe(500);
  });

  it.each(['isk', 'ugx'])(
    '%s: shown with no decimals, sent to Stripe ×100, in steps of 100',
    (c) => {
      const C = c.toUpperCase();

      expect(scaleOf(c)).toBe(0);
      expect(stepOf(c)).toBe(100);
      expect(parseMoney('500', c)).toBe(50000);
      expect(toQuantity(50000, c)).toEqual({ amount: 500, unit: C });
      expect(formatMoney(50000, c)).toBe(`500 ${C}`);
      // An API amount that doesn't end in 00 keeps Stripe's two decimals, so it stays exact.
      expect(toQuantity(50050, c)).toEqual({
        amount: 50050,
        scale: 2,
        unit: C,
      });
      expect(roundDown(12345, c)).toBe(12300);
      expect(() => parseMoney('5.5', c)).toThrow(/at most 0 decimals/);
    },
  );

  it.each(['bhd', 'jod', 'kwd', 'omr', 'tnd'])(
    '%s has three decimals, and Stripe takes amounts ending in 0',
    (c) => {
      const C = c.toUpperCase();

      expect(scaleOf(c)).toBe(3);
      expect(stepOf(c)).toBe(10);
      expect(parseMoney('5.12', c)).toBe(5120);
      expect(parseMoney('5.120', c)).toBe(5120);
      expect(toQuantity(5120, c)).toEqual({ amount: 5120, scale: 3, unit: C });
      expect(formatMoney(5120, c)).toBe(`5.120 ${C}`);
      expect(() => parseMoney('5.125', c)).toThrow(
        `Stripe only takes ${C} amounts in steps of 0.010 ${C}`,
      );
      expect(() => parseMoney('5.1255', c)).toThrow(/at most 3 decimals/);
      expect(roundDown(5125, c)).toBe(5120);
    },
  );

  it('refuses amounts that aren’t decimal strings', () => {
    for (const bad of ['', 'abc', '-5', '1e3', '1,50', '.5']) {
      expect(() => parseMoney(bad, 'usd')).toThrow(/decimal number/);
    }

    expect(() => parseMoney('99999999999999999', 'usd')).toThrow(/too large/);
  });

  it.each([
    {
      cur: 'isk',
      amount: 1_000_000,
      api: 480_500,
      spend: { amount: 4805, unit: 'ISK' },
    },
    {
      cur: 'kwd',
      amount: 10_000,
      api: 4_800,
      spend: { amount: 4800, scale: 3, unit: 'KWD' },
    },
    {
      cur: 'jpy',
      amount: 3000,
      api: 1441,
      spend: { amount: 1441, unit: 'JPY' },
    },
  ])(
    'a $cur refund of what’s unused is rounded to an amount Stripe takes, and spends exactly that',
    async ({ cur, amount, api, spend }) => {
      const s = setup({
        state: (b) => ({
          charges: b.charges.map((ch) => ({ ...ch, currency: cur, amount })),
        }),
      });
      const plans = await plansOf(refundJob(s.ctx), { customer: 'Chen' });
      const unused = plans[1];

      expect(unused.summary).toContain('unused 15 days');
      expect(unused.uses).toEqual({ spend });
      await unused.apply();
      expect(s.stripe.writes()[0].body).toBe(
        `payment_intent=pi_2&amount=${api}`,
      );
    },
  );

  it('the default period is 30 days, 14 days 10 hours of it left from the start of today', () => {
    const f = fakeStripe({ now: NOW });
    const sub = f.subs[0].items.data[0];

    expect(sub.current_period_end - sub.current_period_start).toBe(30 * D);
  });
});
