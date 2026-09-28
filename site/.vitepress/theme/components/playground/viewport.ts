/**
 * The breakpoints the playground's script reacts to, matching its CSS: one column below
 * 980px, a phone below 640px. False on the server, where there is no viewport.
 */

/** The panes stack in one column. */
export const ONE_COLUMN = '(max-width: 980px)';

/** A phone-sized screen. */
export const PHONE = '(max-width: 640px)';

export const matches = (query: string) =>
  typeof window !== 'undefined' && window.matchMedia(query).matches;

/** Whether the user asked for less motion. */
export const reducedMotion = () => matches('(prefers-reduced-motion: reduce)');
