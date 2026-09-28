/**
 * Lens for untrusted text: a service's reply or effect re-rendered from its
 * fields made one line, so its text can't forge a line or hide characters.
 */
import { printable } from '../text.js';
import type { Effect, Reply } from '../types.js';
import { isObject } from '../util.js';
import { effectLine } from './format.js';
import { lens } from './render.js';

/**
 * `v` with every string (and key) made one line by `printable`. For showing a service's fields
 * without letting a summary forge a line.
 */
export function oneLine(v: unknown): unknown {
  if (typeof v === 'string') {
    return printable(v);
  }

  if (Array.isArray(v)) {
    return v.map(oneLine);
  }

  if (typeof v !== 'object' || v === null) {
    return v;
  }

  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [printable(k), oneLine(x)]),
  );
}

/**
 * `safe` (`orig` after `oneLine`) with `keys` put back from `orig`, and each of its `effects`'
 * `from` and `to`: values Lens quotes itself, which `printable` first would only escape twice.
 */
function keepQuoted(orig: unknown, safe: unknown, keys: string[]): unknown {
  if (!isObject(orig) || !isObject(safe)) {
    return safe;
  }

  const out: Record<string, unknown> = { ...safe };

  for (const k of keys) {
    if (Object.hasOwn(orig, k)) {
      out[k] = orig[k];
    }
  }

  const effects = orig.effects;

  if (Array.isArray(effects) && Array.isArray(safe.effects)) {
    out.effects = safe.effects.map((e, i) =>
      keepQuoted(effects[i], e, ['from', 'to']),
    );
  }

  return out;
}

/**
 * An effect line for a person or a model: its fields made one line by `oneLine`, except `from`
 * and `to`, which Lens quotes itself; then the whole line through `printable`, for what the
 * quotes leave.
 */
export const safeEffectLine = (e: Effect) =>
  printable(effectLine(keepQuoted(e, oneLine(e), ['from', 'to']) as Effect));

/**
 * `safe` (`r` after `oneLine`) with the values Lens renders quoted put back: an ANSWER's
 * `data`, a proposal's `data` and a receipt's `result` (lean, SPEC §9.1), and effects' `from`
 * and `to` (scalars). Only where Lens renders them: a `data` key elsewhere, such as a
 * capability's param, is shown bare and stays escaped.
 */
function quotedBack(r: Reply, safe: unknown): unknown {
  if (!isObject(safe)) {
    return safe;
  }

  switch (r.kind) {
    case 'ANSWER':
      return keepQuoted(r, safe, ['data']);
    case 'PROPOSALS':
      return {
        ...safe,
        proposals: Array.isArray(safe.proposals)
          ? safe.proposals.map((p, i) =>
              keepQuoted(r.proposals[i], p, ['data']),
            )
          : safe.proposals,
      };
    case 'RECEIPT':
      return {
        ...safe,
        receipt: keepQuoted(r.receipt, safe.receipt, ['result']),
      };
    default:
      return safe;
  }
}

/**
 * A service's reply as Lens, for a model or a person: re-rendered from its fields after
 * `oneLine`, never the service's own `lens`, so every line break is ours. Quoted values escape
 * only C0, so each line then goes through `printable`, for the C1, bidi, line-separator and
 * invisible characters left inside quotes. `printable` leaves backslashes alone, so text
 * already escaped isn't escaped again.
 */
export function untrustedLens(reply: Reply): string {
  const { lens: _ignored, ...rest } = reply;

  return lens(quotedBack(reply, oneLine(rest)) as Reply)
    .split('\n')
    .map(printable)
    .join('\n');
}
