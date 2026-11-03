/**
 * The import statements in a Python file. Comments and string literals
 * (docstrings among them) are taken out first, so an import quoted in one
 * isn't read as one. A statement may be indented, follow a `;` or a `:`, wrap
 * its names in parentheses or continue past a backslash.
 */

const QUOTES = new Set(["'", '"']);

/** `from <dots><module> import <names>`, the names in parentheses or not. */
const FROM =
  /(?:^|[;:])[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import\b[ \t]*(\([^)]*\)|[^\n;]*)/gm;

/** `import <module> [as <alias>], …`. */
const IMPORT = /(?:^|[;:])[ \t]*import[ \t]+([^\n;]*)/gm;

/** The index just past the string literal opening at `i`, triple-quoted or not. */
function literalEnd(text, i) {
  const triple = text[i].repeat(3);
  const close = text.startsWith(triple, i) ? triple : text[i];
  let j = i + close.length;

  while (j < text.length && !text.startsWith(close, j)) {
    if (close.length === 1 && text[j] === '\n') {
      return j;
    }

    j += text[j] === '\\' ? 2 : 1;
  }

  return Math.min(j + close.length, text.length);
}

/** The end of the comment or string at `i`, or undefined when neither starts there. */
function skipEnd(text, i) {
  if (text[i] === '#') {
    const end = text.indexOf('\n', i);

    return end < 0 ? text.length : end;
  }

  return QUOTES.has(text[i]) ? literalEnd(text, i) : undefined;
}

/** Python source with each comment taken out and each string literal emptied. */
function stripPython(text) {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const end = skipEnd(text, i);

    if (end === undefined) {
      out += text[i];
      i += 1;
    } else {
      out += text[i] === '#' ? '' : "''";
      i = end;
    }
  }

  return out.replace(/\\\n/g, ' ');
}

/** The first word of each comma-separated item: `a as b, c` is `a`, `c`. */
function firstWords(list) {
  return list
    .replace(/[()]/g, '')
    .split(',')
    .map((item) => item.trim().split(/\s+/)[0])
    .filter((word) => word !== '');
}

/**
 * The imports in a Python file, as `{ level, module, names }`: `level` counts
 * the leading dots of a relative import, and `names` are what a `from` import
 * takes from `module` (empty for a plain `import module`).
 */
export function pythonImports(text) {
  const code = stripPython(text);
  const from = [...code.matchAll(FROM)].map((m) => ({
    level: m[1].length,
    module: m[2],
    names: firstWords(m[3]),
  }));
  const plain = [...code.matchAll(IMPORT)].flatMap((m) =>
    firstWords(m[1]).map((module) => ({ level: 0, module, names: [] })),
  );

  return [...from, ...plain];
}
