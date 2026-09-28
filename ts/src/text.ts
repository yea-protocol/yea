/**
 * Showing untrusted text on a terminal (`yea approve`). Text from a consent code is untrusted:
 * control characters (C0, C1, DEL), line separators and bidi overrides could rewrite what the
 * person reads before signing, so they're shown as escapes.
 */

/** C0 (except tab), DEL, C1, line and paragraph separators, and bidi marks and overrides. */
function unsafeChar(cp: number): boolean {
  return (
    (cp < 0x20 && cp !== 0x09) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x061c ||
    cp === 0x200e ||
    cp === 0x200f ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

/** One line of untrusted text; a newline inside it is escaped, so it can't add fake lines. */
export const printable = (s: string) =>
  [...s]
    .map((c) => {
      const cp = c.codePointAt(0) ?? 0;

      return unsafeChar(cp) ? `\\u{${cp.toString(16)}}` : c;
    })
    .join('');

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
