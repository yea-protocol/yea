/**
 * The code in a TS, JS or Vue file with its comments taken out, so that an
 * import quoted in a comment or commented out isn't read as one. Strings,
 * template literals and regex literals are kept whole, so a `//` or `/*`
 * inside one isn't taken for a comment. Of a Vue file only the `<script>`
 * blocks count.
 */

const QUOTES = new Set(["'", '"', '`']);

/** Code after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER =
  /(^|[(,=:[!&|?{};+\-*%<>~^]|\b(return|typeof|case|do|else|in|of|void|yield|await))$/;

const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

/** The index just past the string or template literal opening at `i`. */
function literalEnd(text, i) {
  const close = text[i];
  let j = i + 1;

  while (j < text.length && text[j] !== close) {
    if (close !== '`' && text[j] === '\n') {
      return j;
    }

    j += text[j] === '\\' ? 2 : 1;
  }

  return j + 1;
}

/** The index just past the regex literal opening at `i`. */
function regexEnd(text, i) {
  let inClass = false;
  let j = i + 1;

  while (j < text.length && text[j] !== '\n') {
    const c = text[j];

    if (c === '/' && !inClass) {
      return j + 1;
    }

    inClass = (inClass || c === '[') && c !== ']';
    j += c === '\\' ? 2 : 1;
  }

  return j;
}

/** The end of a comment opening at `i`, or undefined when none does. */
function commentEnd(text, i) {
  if (text.startsWith('//', i)) {
    const end = text.indexOf('\n', i);

    return end < 0 ? text.length : end;
  }

  if (text.startsWith('/*', i)) {
    const end = text.indexOf('*/', i + 2);

    return end < 0 ? text.length : end + 2;
  }

  return undefined;
}

/** The token at `i`: where it ends, and whether it is code to keep. */
function token(text, i, before) {
  const comment = commentEnd(text, i);

  if (comment !== undefined) {
    return { end: comment, keep: false };
  }

  if (QUOTES.has(text[i])) {
    return { end: literalEnd(text, i), keep: true };
  }

  if (text[i] === '/' && REGEX_AFTER.test(before().trimEnd())) {
    return { end: regexEnd(text, i), keep: true };
  }

  return { end: i + 1, keep: true };
}

/** TS or JS source with each comment replaced by a space. */
export function stripComments(text) {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const { end, keep } = token(text, i, () => out.slice(-200));

    out += keep ? text.slice(i, end) : ' ';
    i = end;
  }

  return out;
}

/** The code of the file at `path`: its comments gone, and only `<script>` for Vue. */
export function codeOf(path, text) {
  const script = path.endsWith('.vue')
    ? [...text.matchAll(SCRIPT_BLOCK)].map((m) => m[1]).join('\n')
    : text;

  return stripComments(script);
}
