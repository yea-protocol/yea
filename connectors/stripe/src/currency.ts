/**
 * Stripe's currency rules, in one place (docs.stripe.com/currencies). Amounts inside the
 * connector are always Stripe's API integers; this module turns them into `spend` quantities
 * (docs/conventions.md), text people read, and back from the strings a tool's input holds.
 */
import { fmtQuantity, type Quantity } from '@yea-protocol/sdk';

/** Zero-decimal currencies: the API amount is the amount (¥500 is 500). */
const ZERO_DECIMAL = new Set([
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
]);

/** Three-decimal currencies: Stripe wants their API amounts to end in 0. */
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** Shown without decimals, but sent to Stripe as two-decimal values ending in 00. */
const TIMES_100 = new Set(['ISK', 'UGX']);

const code = (currency: string) => currency.toUpperCase();

/** The currency's decimals, as people and `spend` see it. */
export function scaleOf(currency: string): 0 | 2 | 3 {
  const c = code(currency);

  if (ZERO_DECIMAL.has(c) || c === 'ISK') {
    return 0;
  }

  return THREE_DECIMAL.has(c) ? 3 : 2;
}

/** API integers per shown minor unit: 100 for ISK and UGX, else 1. */
const factorOf = (currency: string) =>
  TIMES_100.has(code(currency)) ? 100 : 1;

/** The smallest API step Stripe accepts: 100 for ISK and UGX, 10 for three-decimal currencies. */
export function stepOf(currency: string): number {
  if (TIMES_100.has(code(currency))) {
    return 100;
  }

  return THREE_DECIMAL.has(code(currency)) ? 10 : 1;
}

/** Round an API amount down to one Stripe accepts. */
export const roundDown = (api: number, currency: string) =>
  api - (api % stepOf(currency));

/**
 * An API amount as an exact `spend` quantity. An ISK or UGX amount that doesn't end in 00 keeps
 * Stripe's two decimals, so the value is still exact.
 */
export function toQuantity(api: number, currency: string): Quantity {
  const f = factorOf(currency);
  const unit = code(currency);

  if (f > 1 && api % f !== 0) {
    return { amount: api, scale: 2, unit };
  }

  const scale = scaleOf(currency);

  return { amount: api / f, ...(scale ? { scale } : {}), unit };
}

/** `12.50 USD`, `500 JPY`, `1.250 KWD`. */
export const formatMoney = (api: number, currency: string) =>
  fmtQuantity(toQuantity(api, currency));

/** The number alone, as a person types it to approve: `12.50`, `500`. */
export const formatNumber = (api: number, currency: string) =>
  formatMoney(api, currency).split(' ')[0] ?? '';

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * An amount a tool's input gave as a string (job inputs can't hold fractions), as an API
 * amount. Throws, saying why, for anything Stripe wouldn't take in this currency.
 */
export function parseMoney(text: string, currency: string): number {
  const m = DECIMAL.exec(text.trim());
  const scale = scaleOf(currency);

  if (!m) {
    throw new TypeError(
      `amount must be a decimal number written as a string, like "12.50"; got ${JSON.stringify(text)}`,
    );
  }

  const decimals = m[2] ?? '';

  if (decimals.length > scale) {
    throw new TypeError(
      `${code(currency)} amounts have at most ${scale} decimals; ${text} has ${decimals.length}`,
    );
  }

  const minor = Number(`${m[1]}${decimals.padEnd(scale, '0')}`);
  const api = minor * factorOf(currency);

  if (!Number.isSafeInteger(api)) {
    throw new TypeError(`amount ${text} is too large`);
  }

  if (api % stepOf(currency) !== 0) {
    throw new TypeError(
      `Stripe only takes ${code(currency)} amounts in steps of ${formatMoney(stepOf(currency), currency)}`,
    );
  }

  return api;
}
