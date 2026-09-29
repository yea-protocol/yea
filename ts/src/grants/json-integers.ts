/**
 * Number literals in a grant token's JSON (SPEC §6.2, §10): every number is an integer written in
 * minimal form. JSON.parse reads `1.0`, `1e3` and `-0` as integers, so the text itself is checked.
 */

/** An integer in minimal decimal form: no fraction, no exponent, no leading zero, no `-0`. */
const MINIMAL_INTEGER = /^(0|-?[1-9][0-9]*)$/;
const NUMBER_CHAR = /[0-9.eE+-]/;

/** The index just past the JSON string that opens at `i`. */
function skipString(text: string, i: number): number {
  let j = i + 1;

  while (j < text.length && text[j] !== '"') {
    j += text[j] === '\\' ? 2 : 1;
  }

  return j + 1;
}

/** The index just past the number literal that starts at `i`. */
function skipNumber(text: string, i: number): number {
  let j = i + 1;

  while (j < text.length && NUMBER_CHAR.test(text[j])) {
    j++;
  }

  return j;
}

/**
 * Whether valid JSON `text` holds a number literal that isn't an integer in minimal form.
 * Outside strings, a number is the only token that starts with `-` or a digit.
 */
export function hasNonMinimalNumber(text: string): boolean {
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (c === '"') {
      i = skipString(text, i);
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      const end = skipNumber(text, i);

      if (!MINIMAL_INTEGER.test(text.slice(i, end))) {
        return true;
      }

      i = end;
    } else {
      i++;
    }
  }

  return false;
}
