/**
 * The confirmation phrase (docs/framework/SPEC-approval.md §3): how a typed
 * answer is normalized and matched, the `approve` fallback, and the printable-text rule.
 */
import type { HashedPlan } from '../approval.js';
import { printable } from '../text.js';

/** The phrase a person types to approve this plan: the tool's, or `approve`. */
export type PhraseFor = (hp: HashedPlan) => string;

/** Exactly these are stripped from both ends; not trim()/strip(), which disagree. */
const EDGE = /^[\t\n\v\f\r \u00a0\ufeff]+|[\t\n\v\f\r \u00a0\ufeff]+$/g;

export const DEFAULT_PHRASE = 'approve';

const normalizePhrase = (s: string) =>
  s.normalize('NFC').replace(EDGE, '').toLowerCase();

/** An empty phrase never matches, so an empty or auto-filled answer can't approve. */
export const phraseMatches = (typed: unknown, phrase: string) =>
  typeof typed === 'string' &&
  normalizePhrase(phrase) !== '' &&
  normalizePhrase(typed) === normalizePhrase(phrase);

/** A phrase that is empty once normalized falls back to `approve`. */
export const effectivePhrase = (phrase: string) =>
  normalizePhrase(phrase) === '' ? DEFAULT_PHRASE : phrase;

/**
 * A tool's phrase, checked before anyone is asked (§3): it must be printable text, since the
 * person is shown it escaped and could never type the raw characters, so anything else is a
 * developer error. `whose` names the phrase in the error. Then the `approve` fallback applies.
 */
export function checkedPhrase(
  phrase: string,
  whose = 'the approval phrase',
): string {
  if (printable(phrase) !== phrase) {
    throw new TypeError(
      `${whose} has unprintable characters, so no one could type it: "${printable(phrase)}"`,
    );
  }

  return effectivePhrase(phrase);
}

export const withFallback =
  (phraseFor: PhraseFor): PhraseFor =>
  (hp) =>
    effectivePhrase(phraseFor(hp));
