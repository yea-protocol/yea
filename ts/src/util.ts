/** Small helpers the SDK shares. `unixNow` is public; the rest are internal. */

/** Seconds since the Unix epoch, the clock of every YEA timestamp. */
export const unixNow = () => Math.floor(Date.now() / 1000);

/** One day in seconds. */
export const DAY = 86400;

/** An array of strings. */
export const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A JSON object: not null and not an array. */
export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An error's `code`, such as Node's `ENOENT`; undefined when it has no string code. */
export const errno = (e: unknown): string | undefined =>
  isObject(e) && typeof e.code === 'string' ? e.code : undefined;

/** A whole number above 0, as a frame's `budget` must be; anything else is undefined. */
export const positiveInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
