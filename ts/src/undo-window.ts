/**
 * Undo windows (SPEC.md §5.1, SPEC-approval §1): only a positive whole number of seconds is one.
 * Anything else, zero included, means the action can't be undone.
 */

/**
 * Whether `v` is an undo window: a positive safe integer (1 to 2^53−1 seconds). Zero, negatives,
 * fractions, strings and everything else are not, so a plan with one is not undoable, a service
 * sends `undo: null` for it, and every renderer shows `never`.
 */
export const isUndoWindow = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
