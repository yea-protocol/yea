/**
 * The imports in a Python file. Comments and string literals (docstrings
 * among them) are taken out first, so an import quoted in one isn't read as
 * one. A statement may be indented, follow a `;` or a `:`, wrap its names in
 * parentheses or continue past a backslash, and is read in every spelling
 * Python accepts: names folded by NFKC as Python folds identifiers, form
 * feeds as spaces, spaces around dots. `__import__` and
 * `importlib.import_module` calls count too when their names are literals,
 * as `import()` and `require()` do in TS: one-line literals, optionally `r`
 * or `u` prefixed, that hold only a module name. Only such a literal is kept
 * for that pass, so a call quoted in a string or docstring isn't read; a
 * name built from triple-quoted or concatenated literals isn't either. A
 * part reached as an attribute of its package (`yea.store.files` after
 * `import yea.store`) isn't an import, and no reader sees it.
 */

const QUOTES = new Set(["'", '"']);

/** `from <dots><module> import <names>`, the names in parentheses or not. */
const FROM =
  /(?:^|[;:])[ \t]*from[ \t]+(\.*)([\p{ID_Continue}.]*?)[ \t]*\bimport\b[ \t]*(\([^)]*\)|[^\n;]*)/gmu;

/** `import <module> [as <alias>], …`. */
const IMPORT = /(?:^|[;:])[ \t]*import[ \t]+([^\n;]*)/gmu;

/** `__import__('<name>')` or `import_module('<name>'[, [package=]'<package>'])`, with literal names. */
const DYNAMIC =
  /\b(?:__import__|import_module)\s*\(\s*[rRuU]?(['"])([\p{ID_Continue}.]+)\1(?:\s*,\s*(?:package\s*=\s*)?[rRuU]?(['"])([\p{ID_Continue}.]+)\3)?/gu;

/** A string literal that can be a module name: one quote each side, only name characters. */
const NAME_LITERAL = /^(['"])[\p{ID_Continue}.]*\1$/u;

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

/** Python source with each comment taken out, and each string literal put through `literal`. */
function stripPython(text, literal) {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const end = skipEnd(text, i);

    if (end === undefined) {
      out += text[i];
      i += 1;
    } else {
      out += text[i] === '#' ? '' : literal(text.slice(i, end));
      i = end;
    }
  }

  return out.replace(/\\\n/g, ' ');
}

/**
 * Code in one spelling of each import: names folded by NFKC, form feeds as
 * spaces, no spaces around a dot, and `from.x` as `from .x`.
 */
function normalise(code) {
  return code
    .normalize('NFKC')
    .replaceAll('\f', ' ')
    .replace(/[ \t]*\.[ \t]*/g, '.')
    .replace(/\bfrom(?=\.)/g, 'from ');
}

/** `.name` as its level and module: `{ level: 1, module: 'name' }`. */
function relative(name) {
  const dots = /^\.*/.exec(name)?.[0] ?? '';

  return { level: dots.length, module: name.slice(dots.length) };
}

/** The literal `__import__` and `import_module` calls in code that keeps only its name literals. */
function dynamicImports(code) {
  return [...code.matchAll(DYNAMIC)]
    .map((m) => ({ ...relative(m[2]), names: [], package: m[4] }))
    .filter((found) => found.level === 0 || found.package !== undefined);
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
 * The imports in a Python file, as `{ level, module, names, package? }`:
 * `level` counts the leading dots of a relative import, `names` are what a
 * `from` import takes from `module` (empty for a plain `import module`), and
 * `package` is what `import_module` resolves a relative name against.
 */
export function pythonImports(text) {
  const code = normalise(stripPython(text, () => "''"));
  const from = [...code.matchAll(FROM)].map((m) => ({
    level: m[1].length,
    module: m[2],
    names: firstWords(m[3]),
  }));
  const plain = [...code.matchAll(IMPORT)].flatMap((m) =>
    firstWords(m[1]).map((module) => ({ level: 0, module, names: [] })),
  );

  const names = (literal) => (NAME_LITERAL.test(literal) ? literal : "''");
  const dynamic = dynamicImports(stripPython(text, names));

  return [...from, ...plain, ...dynamic];
}
