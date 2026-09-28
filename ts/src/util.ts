/** Small helpers the SDK shares. `unixNow` is public; the rest are internal. */

/** Seconds since the Unix epoch, the clock of every YEA timestamp. */
export const unixNow = () => Math.floor(Date.now() / 1000);

/** An array of strings. */
export const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A JSON object: not null and not an array. */
export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
