/** Small helpers the job plugin and the bridge share. Internal: not part of the package's API. */

export type Obj = Record<string, unknown>;

/** A plain object: not null, and not an array. */
export const isObject = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What was thrown, as text: an Error's message, or anything else as a string. */
export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

const warned = new Set<string>();

/** Warn on stderr, once per message, so a per-call read doesn't flood the log. */
export function warnOnce(message: string) {
  if (!warned.has(message)) {
    warned.add(message);
    console.error(`yea: ${message}`);
  }
}
