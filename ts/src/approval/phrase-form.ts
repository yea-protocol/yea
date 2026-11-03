/**
 * The confirmation phrase's normal form and its `approve` fallback (SPEC-approval §3): what a
 * typed answer is compared in, and the phrase a consent hash binds. Typeability and matching are
 * in ask/phrase.ts.
 */

/** Exactly these are stripped from both ends; not trim()/strip(), which disagree. */
export const PHRASE_EDGE = /^[\t\n\v\f\r  ﻿]+|[\t\n\v\f\r  ﻿]+$/g;

export const DEFAULT_PHRASE = 'approve';

/** NFC, then the edge set stripped, then lowercased: the form both sides are compared in. */
export const normalizePhrase = (s: string) =>
  s.normalize('NFC').replace(PHRASE_EDGE, '').toLowerCase();

/** A phrase that is empty once normalized falls back to `approve`. */
export const effectivePhrase = (phrase: string) =>
  normalizePhrase(phrase) === '' ? DEFAULT_PHRASE : phrase;
