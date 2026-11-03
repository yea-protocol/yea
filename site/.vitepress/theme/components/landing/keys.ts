/**
 * Keyboard guards shared by the hero's buttons. After a step, focus moves to the next button
 * (Approve, Skip, Undo, Start again); a key still held down from the last press repeats, and
 * must not press it. A step can settle within the key's repeat delay, so every button a press
 * can hand focus to drops repeats.
 */

/** On keydown: a repeat from a held key doesn't activate the button; only a fresh press does. */
export function noRepeat(e: KeyboardEvent) {
  if (e.repeat) {
    e.preventDefault();
  }
}
