/**
 * The import graph of a set of TypeScript sources, and an allowlist audit over it (AGENTS.md
 * rule 3, #337). The code that reads a form answer may import only the modules a test lists, and
 * never loads code at run time, so a new way to sign (another process, Node's crypto, a key read
 * through a new module) fails until someone reviews it. It reads tokens (tokens.ts), never raw
 * text, so a comment can't hide an import; a file or import it can't read fails the audit.
 * mcp/test imports this by relative path.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Token, TokenError, tokenize } from './tokens.js';

/** The repo's root. */
export const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** Names that load code or reach Node's internals at run time: refused wherever they appear. */
const REFUSED_NAMES = new Set([
  'createRequire',
  'getBuiltinModule',
  'binding',
  '_linkedBinding',
  'dlopen',
]);
/** Names refused when called: `require(`, `eval(`, and `Function(` with or without `new`. */
const REFUSED_CALLS = new Set(['require', 'eval', 'Function']);

/** What one file imports, what it does that's refused, and what its tokens couldn't tell. */
export interface FileImports {
  specifiers: string[];
  refused: string[];
  unreadable: string[];
}

const is = (t: Token | undefined, kind: Token['kind'], value?: string) =>
  t !== undefined &&
  t.kind === kind &&
  (value === undefined || t.value === value);

/** The index after the `{ … }` group that opens at `i`. */
function afterBraces(t: Token[], i: number): number {
  let depth = 0;

  for (let j = i; j < t.length; j++) {
    depth += is(t[j], 'punct', '{') ? 1 : is(t[j], 'punct', '}') ? -1 : 0;

    if (depth === 0) {
      return j + 1;
    }
  }

  return t.length;
}

/** The `require('m')` that starts at `j`, as its module, or null. */
function requireAt(t: Token[], j: number): string | null {
  const ok =
    is(t[j], 'name', 'require') &&
    is(t[j + 1], 'punct', '(') &&
    is(t[j + 2], 'string');

  return ok ? t[j + 2].value : null;
}

/**
 * The module an `import` at `i` names, and whether it's a `require`, or null when the tokens
 * aren't an import this audit knows. Its forms: `import 'm'`, `import [type] a, { b }, * as c
 * from 'm'`, and `import a = require('m')`.
 */
function importAt(
  t: Token[],
  i: number,
): { spec: string; require: boolean } | null {
  if (is(t[i + 1], 'string')) {
    return { spec: t[i + 1].value, require: false };
  }

  for (let j = i + 1; j < t.length; j++) {
    const tok = t[j];

    if (is(tok, 'punct', '{')) {
      j = afterBraces(t, j) - 1;
    } else if (is(tok, 'name', 'from') && is(t[j + 1], 'string')) {
      return { spec: t[j + 1].value, require: false };
    } else if (is(tok, 'punct', '=')) {
      const spec = requireAt(t, j + 1);

      return spec === null ? null : { spec, require: true };
    } else if (
      !(tok.kind === 'name' || is(tok, 'punct', ',') || is(tok, 'punct', '*'))
    ) {
      return null;
    }
  }

  return null;
}

/** The module an `export … from` at `i` re-exports, or null for an `export` that re-exports nothing. */
function reExportAt(t: Token[], i: number): string | null {
  let j = is(t[i + 1], 'name', 'type') ? i + 2 : i + 1;

  if (is(t[j], 'punct', '{')) {
    j = afterBraces(t, j);
  } else if (is(t[j], 'punct', '*')) {
    j += is(t[j + 1], 'name', 'as') ? 3 : 1;
  } else {
    return null;
  }

  return is(t[j], 'name', 'from') && is(t[j + 1], 'string')
    ? t[j + 1].value
    : null;
}

/** The refused construct the token at `i` starts, or null. */
function refusedAt(t: Token[], i: number): string | null {
  const tok = t[i];

  if (tok.kind === 'string' || tok.kind === 'template') {
    const named = REFUSED_NAMES.has(tok.value) || REFUSED_CALLS.has(tok.value);

    return named ? `'${tok.value}'` : null;
  }

  if (tok.kind !== 'name') {
    return null;
  }

  if (REFUSED_NAMES.has(tok.value)) {
    const owner =
      is(t[i - 1], 'punct', '.') && is(t[i - 2], 'name')
        ? `${t[i - 2].value}.`
        : '';

    return `${owner}${tok.value}`;
  }

  return REFUSED_CALLS.has(tok.value) && is(t[i + 1], 'punct', '(')
    ? `${tok.value}(`
    : null;
}

/** Record the `import` at `i`: a dynamic one is refused, a static one names its module. */
function readImport(t: Token[], i: number, out: FileImports) {
  if (is(t[i + 1], 'punct', '(')) {
    out.refused.push('import(');

    return;
  }

  if (is(t[i + 1], 'punct', '.')) {
    return; // import.meta
  }

  const found = importAt(t, i);

  if (found === null) {
    out.unreadable.push(`line ${t[i].line}: an import this audit can't read`);

    return;
  }

  out.specifiers.push(found.spec);

  if (found.require) {
    out.refused.push('require(');
  }
}

/** What `file` imports and does that's refused, read from its tokens. */
export function fileImports(file: string): FileImports {
  const out: FileImports = { specifiers: [], refused: [], unreadable: [] };
  let t: Token[];

  try {
    t = tokenize(readFileSync(file, 'utf8'));
  } catch (e) {
    const why = e instanceof TokenError ? e.message : String(e);

    out.unreadable.push(`does not tokenize, ${why}`);

    return out;
  }

  for (let i = 0; i < t.length; i++) {
    const member = is(t[i - 1], 'punct', '.');
    const inImportEquals =
      is(t[i - 1], 'punct', '=') &&
      is(t[i - 2], 'name') &&
      is(t[i - 3], 'name', 'import');

    if (is(t[i], 'name', 'import') && !member) {
      readImport(t, i, out);
    } else if (is(t[i], 'name', 'export') && !member) {
      const spec = reExportAt(t, i);

      if (spec !== null) {
        out.specifiers.push(spec);
      }
    } else if (!inImportEquals) {
      const refused = refusedAt(t, i);

      if (refused !== null) {
        out.refused.push(refused);
      }
    }
  }

  return out;
}

/** The module specifiers a source file imports or re-exports; throws if it can't be read. */
export function importsOf(file: string): string[] {
  const found = fileImports(file);

  if (found.unreadable.length > 0) {
    throw new Error(`${relative(REPO, file)}: ${found.unreadable.join('; ')}`);
  }

  return found.specifiers;
}

/** A relative specifier as the source file it names: `./x.js` is `./x.ts`. */
const sourceOf = (from: string, spec: string) =>
  join(dirname(from), spec.replace(/\.js$/, '.ts'));

/** The files reachable from `starts` through relative imports, and the specifiers that name no file. */
function graph(starts: string[]) {
  const seen = new Map<string, FileImports>();
  const unresolved: string[] = [];
  const queue = [...starts];

  for (let f = queue.pop(); f !== undefined; f = queue.pop()) {
    if (seen.has(f)) {
      continue;
    }

    const found = fileImports(f);

    seen.set(f, found);

    for (const spec of found.specifiers.filter((s) => s.startsWith('.'))) {
      const target = sourceOf(f, spec);

      if (existsSync(target)) {
        queue.push(target);
      } else {
        unresolved.push(`${relative(REPO, f)}: cannot resolve ${spec}`);
      }
    }
  }

  return { seen, unresolved };
}

/** Every source file reachable from `starts` through relative imports, type-only ones included. */
export function reachable(starts: string[]): string[] {
  return [...graph(starts).seen.keys()].sort();
}

/**
 * Which modules the path may import: each maps to `'any file'`, or to the files (relative to the
 * repo) that may import it.
 */
export type Allowed = Record<string, 'any file' | string[]>;

/**
 * Each import on the path from `starts` that isn't relative and isn't allowed in its file, each
 * refused construct, and each file or import the audit can't read or resolve, as `file: …`.
 * Empty means the path is as reviewed.
 */
export function importAudit(starts: string[], allowed: Allowed): string[] {
  const { seen, unresolved } = graph(starts);
  const out: string[] = [];

  for (const f of [...seen.keys()].sort()) {
    const name = relative(REPO, f);
    const found = seen.get(f) ?? {
      specifiers: [],
      refused: [],
      unreadable: [],
    };

    for (const spec of found.specifiers) {
      const files = Object.hasOwn(allowed, spec) ? allowed[spec] : [];
      const ok = files === 'any file' || files.includes(name);

      if (!spec.startsWith('.') && !ok) {
        out.push(`${name}: ${spec}`);
      }
    }

    out.push(...found.refused.map((r) => `${name}: ${r}`));
    out.push(...found.unreadable.map((u) => `${name}: ${u}`));
  }

  return [...out, ...unresolved];
}
