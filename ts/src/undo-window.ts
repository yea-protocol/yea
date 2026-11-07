/**
 * Undo windows (SPEC.md §5.1, SPEC-approval §1): only a positive whole number of seconds, small
 * enough that a commit time plus it is still a safe integer, is one. Anything else, zero
 * included, means the action can't be undone.
 */

/**
 * The longest undo window, in seconds: 2^52 (about 142 million years), so a receipt's `until`,
 * the commit time plus the window, stays a safe integer for any commit before then.
 */
const MAX_UNDO_WINDOW = 2 ** 52;

/**
 * Whether `v` is an undo window: an integer from 1 to `MAX_UNDO_WINDOW` seconds. Zero,
 * negatives, fractions, strings, `null`, larger numbers and everything else are not, so a plan
 * with one is not undoable, a service sends `undo: null` for it, and every renderer shows `never`.
 */
export const isUndoWindow = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= MAX_UNDO_WINDOW;
