/**
 * Showing untrusted text on a terminal (`yea approve`) or to a model (the bridge). Text from a
 * consent code or a service is untrusted: control characters could rewrite what the person
 * reads before signing, and invisible ones could make two different targets look the same or
 * smuggle text to a model, so they're shown as escapes.
 */

/**
 * Controls (C0 but tab, DEL, C1), format characters (bidi marks and overrides, zero-width
 * space and joiners, word joiner, BOM, soft hyphen, U+180E, U+206A–206F, interlinear
 * annotations U+FFF9–FFFB, tag characters U+E0000–E007F), line and paragraph separators, and
 * the Hangul fillers, which are letters that draw nothing.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0]/gu;

/**
 * One line of untrusted text, each unsafe character shown as `\u{hex}`. A newline inside it is
 * escaped, so it can't add fake lines. A zero-width joiner inside an emoji sequence is escaped
 * too (woman, U+200D, laptop shows as 👩\u{200d}💻 rather than one glyph): on a consent
 * screen, seeing every character beats a pretty picture.
 */
export const printable = (s: string) =>
  s.replace(UNSAFE, (c) =>
    c === '\t' ? c : `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`,
  );

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
