/**
 * The confirmation phrase's normal form and its `approve` fallback (SPEC-approval §3): what a
 * typed answer is compared in, and the phrase a consent hash binds. Typeability and matching are
 * in ask/phrase.ts.
 */

/** Exactly these are stripped from both ends; not trim()/strip(), which disagree. */
const EDGE = new Set([
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  ' ',
  String.fromCharCode(0xa0),
  String.fromCharCode(0xfeff),
]);

export const DEFAULT_PHRASE = 'approve';

/**
 * `s` without the edge set at either end. A scan, not a regex: an anchored `[…]+$` is quadratic
 * on a long run of edge characters, and the typed answer is untrusted. Each edge character is
 * one UTF-16 unit, so indexing by unit is safe.
 */
export function stripPhraseEdge(s: string): string {
  let start = 0;
  let end = s.length;

  while (start < end && EDGE.has(s.charAt(start))) {
    start++;
  }

  while (end > start && EDGE.has(s.charAt(end - 1))) {
    end--;
  }

  return s.slice(start, end);
}

/** NFC, then the edge set stripped, then lowercased: the form both sides are compared in. */
export const normalizePhrase = (s: string) =>
  stripPhraseEdge(s.normalize('NFC')).toLowerCase();

/** A phrase that is empty once normalized falls back to `approve`. */
export const effectivePhrase = (phrase: string) =>
  normalizePhrase(phrase) === '' ? DEFAULT_PHRASE : phrase;
