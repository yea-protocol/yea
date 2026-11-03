/**
 * The confirmation phrase (docs/framework/SPEC-approval.md §3): how a typed
 * answer is normalized and matched, the `approve` fallback, and the rule that a phrase is typeable.
 */
import type { HashedPlan } from '../approval.js';
import { clip, printable } from '../text.js';

/** The phrase a person types to approve this plan: the tool's, or `approve`. */
export type PhraseFor = (hp: HashedPlan) => string;

/** Exactly these are stripped from both ends; not trim()/strip(), which disagree. */
const EDGE = /^[\t\n\v\f\r \u00a0\ufeff]+|[\t\n\v\f\r \u00a0\ufeff]+$/g;

export const DEFAULT_PHRASE = 'approve';

/** The longest phrase a tool may name, in code points (§3), so both languages count alike. */
export const MAX_PHRASE = 64;

const normalizePhrase = (s: string) =>
  s.normalize('NFC').replace(EDGE, '').toLowerCase();

/** An empty phrase never matches, so an empty or auto-filled answer can't approve. */
export const phraseMatches = (typed: unknown, phrase: string) =>
  typeof typed === 'string' &&
  normalizePhrase(phrase) !== '' &&
  normalizePhrase(typed) === normalizePhrase(phrase);

/** A phrase that is empty once normalized falls back to `approve`. */
const effectivePhrase = (phrase: string) =>
  normalizePhrase(phrase) === '' ? DEFAULT_PHRASE : phrase;

/** Whitespace a person can't be sure of typing: a tab, or any space separator but U+0020. */
const ODD_SPACE = /(?! )[\t\p{Zs}]/gu;

/** The phrase as an error shows it: printable, odd spaces escaped too, at most 80 characters. */
const shown = (phrase: string) =>
  clip(
    printable(phrase).replace(
      ODD_SPACE,
      (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`,
    ),
    80,
  );

/** Why `phrase` can't be asked for, or null when it's typeable text (§3). */
function untypeable(phrase: string): string | null {
  if (printable(phrase) !== phrase) {
    return 'has unprintable characters, so no one could type it';
  }

  // Edge whitespace is stripped when matching; inside, only a plain space can be typed.
  if (phrase.replace(EDGE, '').match(ODD_SPACE)) {
    return 'has whitespace other than plain spaces inside, so no one could type it';
  }

  return [...phrase].length > MAX_PHRASE
    ? `is longer than ${MAX_PHRASE} characters`
    : null;
}

/**
 * A tool's phrase, checked before anyone is asked (§3): it must be printable text of at most
 * `MAX_PHRASE` characters whose only inner whitespace is plain spaces, since the person is shown
 * it escaped and couldn't type the raw characters. Anything else is a developer error. `whose`
 * names the phrase in the error. Then the `approve` fallback applies. Look-alike letters
 * (homoglyphs) are out of scope.
 */
export function checkedPhrase(
  phrase: string,
  whose = 'the approval phrase',
): string {
  const why = untypeable(phrase);

  if (why) {
    throw new TypeError(`${whose} ${why}: "${shown(phrase)}"`);
  }

  return effectivePhrase(phrase);
}

export const withFallback =
  (phraseFor: PhraseFor): PhraseFor =>
  (hp) =>
    effectivePhrase(phraseFor(hp));
