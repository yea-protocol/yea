/**
 * Showing untrusted text on a terminal (`yea approve`) or to a model (the bridge). Text from a
 * consent code or a service is untrusted: control characters could rewrite what the person
 * reads before signing, and invisible ones could make two different targets look the same or
 * smuggle text to a model, so they're shown as escapes.
 */

/**
 * Control, format, separator and default-ignorable code points, except tab and variation
 * selectors U+FE00–FE0F. That takes in C0, DEL and C1; bidi marks and overrides; zero-width
 * space and joiners, word joiner, BOM and soft hyphen; tag characters and variation selectors
 * 17–256 (U+E0000–E0FFF), which can smuggle text to a model; line and paragraph separators;
 * and fillers that draw nothing (the Hangul fillers, U+034F, U+17B4–17B5).
 *
 * U+FE00–FE0F stay because U+FE0F is in ordinary emoji and they only pick a glyph's style.
 * The Braille blank U+2800 isn't in the set: it shows as a blank cell, not as nothing.
 * `\p{Cf}` also escapes a few visible marks, such as the Arabic number signs U+0600–0605,
 * U+06DD, U+070F and U+08E2, which is acceptable on a consent screen. What matches follows the
 * runtime's Unicode version; that's fine, as this is for display only and never wire bytes.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/** Tab, and variation selectors U+FE00–FE0F, which ordinary emoji use. */
const keep = (cp: number) => cp === 0x09 || (cp >= 0xfe00 && cp <= 0xfe0f);

/**
 * One line of untrusted text, each unsafe character shown as `\u{hex}`. A newline inside it is
 * escaped, so it can't add fake lines. A zero-width joiner inside an emoji sequence is escaped
 * too (woman, U+200D, laptop shows as 👩\u{200d}💻 rather than one glyph): on a consent
 * screen, seeing every character beats a pretty picture.
 */
export const printable = (s: string) =>
  s.replace(UNSAFE, (c) => {
    const cp = c.codePointAt(0) ?? 0;

    return keep(cp) ? c : `\\u{${cp.toString(16)}}`;
  });

/**
 * `s` cut to `max` code points, the last one `…` when cut; a surrogate pair is never split.
 * A `max` below 1 leaves no room even for the `…`, so it gives ''.
 */
export function clip(s: string, max: number): string {
  if (max < 1) {
    return '';
  }

  const chars = [...s];

  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}
