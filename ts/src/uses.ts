/**
 * What a commit uses up (SPEC §5.1) and the limits on it (SPEC §6.3).
 * Measure names and units mean nothing to the protocol; values compare exactly.
 */

/** An amount of one measure: its value is `amount × 10^−scale`. */
export interface Quantity {
  amount: number;
  scale?: number;
  unit?: string;
}

/** Measure name → quantity, as on a proposal or receipt. */
export type Uses = Record<string, Quantity>;

/** The value of an `each` or `total` caveat. */
export interface Limit {
  of: string;
  max: number;
  scale?: number;
  unit?: string;
}

const MAX_SCALE = 18;
const NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const UNIT = /^[A-Za-z0-9_./%-]{1,32}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const isAmount = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

const isScale = (v: unknown) =>
  v === undefined ||
  (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_SCALE);

const isUnit = (v: unknown) =>
  v === undefined || (typeof v === 'string' && UNIT.test(v));

export const isMeasureName = (v: unknown): v is string =>
  typeof v === 'string' && NAME.test(v);

/** Whether `v` has only the given keys. */
const onlyKeys = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));

export function isQuantity(v: unknown): v is Quantity {
  return (
    isObject(v) &&
    onlyKeys(v, ['amount', 'scale', 'unit']) &&
    isAmount(v.amount) &&
    isScale(v.scale) &&
    isUnit(v.unit)
  );
}

export function isUses(v: unknown): v is Uses {
  return (
    isObject(v) &&
    Object.entries(v).every(([k, q]) => isMeasureName(k) && isQuantity(q))
  );
}

export function isLimit(v: unknown): v is Limit {
  return (
    isObject(v) &&
    onlyKeys(v, ['of', 'max', 'scale', 'unit']) &&
    isMeasureName(v.of) &&
    isAmount(v.max) &&
    isScale(v.scale) &&
    isUnit(v.unit)
  );
}

/** The exact value of `q` as an integer count of 10^−18 (the finest scale allowed). */
export function exact(q: { amount: number; scale?: number }): bigint {
  return BigInt(q.amount) * 10n ** BigInt(MAX_SCALE - (q.scale ?? 0));
}

/** Units match when both sides have the same unit or both have none. */
export const sameUnit = (a: { unit?: string }, b: { unit?: string }) =>
  a.unit === b.unit;

/** A limit's ceiling as a quantity, for rendering. */
export const limitQuantity = (l: Limit): Quantity => ({
  amount: l.max,
  ...(l.scale === undefined ? {} : { scale: l.scale }),
  ...(l.unit === undefined ? {} : { unit: l.unit }),
});

/** Lens rendering (SPEC §9.2): exactly `scale` decimals, then the unit; `?` if malformed. */
export function fmtQuantity(q: Quantity): string {
  if (!isQuantity(q)) {
    return '?';
  }

  const scale = q.scale ?? 0;
  const digits = String(q.amount).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const value = scale ? `${whole}.${digits.slice(-scale)}` : whole;

  return q.unit ? `${value} ${q.unit}` : value;
}

/** `emails 1, spend 22.90 USD`: names in canonical (code point) order; `?` if malformed. */
export function fmtUses(uses: Uses): string {
  if (!isUses(uses)) {
    return '?';
  }

  return Object.keys(uses)
    .sort(byCodePoint)
    .map((k) => `${k} ${fmtQuantity(uses[k])}`)
    .join(', ');
}

function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

/** A quantity of `amount` at an optional scale and unit. */
export function quantity(
  amount: number,
  opts: { scale?: number; unit?: string } = {},
): Quantity {
  const q = {
    amount,
    ...(opts.scale ? { scale: opts.scale } : {}),
    ...(opts.unit === undefined ? {} : { unit: opts.unit }),
  };

  if (!isQuantity(q)) {
    throw new Error(`not a valid quantity: ${JSON.stringify(q)}`);
  }

  return q;
}

/**
 * Money by the `spend` convention (docs/conventions.md): `spend('22.87', 'USD')` is
 * `{amount: 2287, scale: 2, unit: 'USD'}`. The scale is the number of decimals written.
 */
export function spend(value: string, currency: string): Quantity {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);

  if (!m) {
    throw new Error(`not a decimal amount: ${value}`);
  }

  const decimals = m[2] ?? '';

  return quantity(Number(m[1] + decimals), {
    scale: decimals.length,
    unit: currency,
  });
}
