/**
 * Keyboard guards shared by the hero's buttons. After a step, focus moves to the next button
 * (Approve, Skip); a key still held down from the last press repeats, and must not press it.
 */

/** On keydown: a repeat from a held key doesn't activate the button; only a fresh press does. */
export function noRepeat(e: KeyboardEvent) {
  if (e.repeat) {
    e.preventDefault();
  }
}
