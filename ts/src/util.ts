/** Small helpers the SDK shares. `unixNow` is public; the rest are internal. */

/** Seconds since the Unix epoch, the clock of every YEA timestamp. */
export const unixNow = () => Math.floor(Date.now() / 1000);

/** One day in seconds. */
export const DAY = 86400;

/** A safe integer: what JSON in a token may hold as a number (SPEC §10). */
export const isSafeInt = (v: unknown): v is number => Number.isSafeInteger(v);

/** An array of strings. */
export const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A JSON object: not null and not an array. */
export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON object whose values are all strings. */
export const isStringRecord = (v: unknown): v is Record<string, string> =>
  isObject(v) && Object.values(v).every((x) => typeof x === 'string');

/** An error's `code`, such as Node's `ENOENT`; undefined when it has no string code. */
export const errno = (e: unknown): string | undefined =>
  isObject(e) && typeof e.code === 'string' ? e.code : undefined;

/** A whole number above 0, as a frame's `budget` must be; anything else is undefined. */
export const positiveInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

/** An array, or an object `{}` or JSON makes: its prototype is `Object.prototype` or null. */
function isPlain(v: unknown): v is object {
  if (Array.isArray(v)) {
    return true;
  }

  if (typeof v !== 'object' || v === null) {
    return false;
  }

  const proto = Object.getPrototypeOf(v);

  return proto === Object.prototype || proto === null;
}

/** `v` copied as `plainCopy` says, `within` the plain parts that hold it. */
function copyWithin(v: unknown, within: Set<object>): unknown {
  if (!isPlain(v) || within.has(v)) {
    return v;
  }

  within.add(v);

  const copy = Array.isArray(v)
    ? v.map((x) => copyWithin(x, within))
    : Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, copyWithin(x, within)]),
      );

  within.delete(v);

  return copy;
}

/**
 * A deep copy of the arrays and plain objects in `v`, read through any proxy, such as a Vue
 * `reactive` store's, which `structuredClone` refuses. Anything else, such as a class instance or
 * a function, is kept as it is, and so is a part that holds itself.
 */
export const plainCopy = <T>(v: T): T => copyWithin(v, new Set()) as T;
