/**
 * The confirmation phrase (docs/framework/SPEC-approval.md §3): how a typed
 * answer is normalized and matched, and the `approve` fallback.
 */
import type { HashedPlan } from '../approval.js';

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

export const withFallback =
  (phraseFor: PhraseFor): PhraseFor =>
  (hp) =>
    effectivePhrase(phraseFor(hp));
