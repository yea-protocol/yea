/**
 * The private-folder rule (ADR-0001) for Python: a module inside a package
 * may be imported only by the package's `__init__.py`, its entry, and by the
 * other modules in the package, nested ones included. So a subpackage's
 * `__init__.py` is open to the package around it, and its other modules
 * aren't. A top-level package (`yea`, `yea_mcp`) stands for its source root,
 * not a module, so its own modules are open to all, and a folder without an
 * `__init__.py` only groups files. Imports resolve by module name across
 * every source root, as Python finds them; the rest (the standard library,
 * dependencies) isn't checked. Test files aren't walked.
 */
import { pythonImports } from './python-imports.mjs';

const INIT = /(^|\/)__init__\.py$/;

/** The module a file under `dir` holds, as `{ path, text, name, isPackage }`. */
function moduleOf(dir, path, text) {
  const relative = path.slice(dir.length + 1);
  const isPackage = INIT.test(relative);
  const name = relative
    .replace(INIT, '')
    .replace(/\.py$/, '')
    .replaceAll('/', '.');

  return { path, text, name, isPackage };
}

/** Every Python module under `sources` but a root's own `__init__.py`. */
function modules(sources) {
  return sources.flatMap(({ dir, files }) =>
    [...files]
      .filter(([path]) => path.endsWith('.py'))
      .map(([path, text]) => moduleOf(dir, path, text))
      .filter((module) => module.name !== ''),
  );
}

/** The name `from <level dots><module>` gives inside `importer`, or undefined past the top. */
function absoluteName(importer, level, module) {
  if (level === 0) {
    return module;
  }

  const parts = importer.name.split('.');
  const kept = parts.length - (importer.isPackage ? 0 : 1) - (level - 1);

  if (kept < 1) {
    return undefined;
  }

  return [...parts.slice(0, kept), module].filter((p) => p !== '').join('.');
}

/**
 * The modules in `index` an import statement loads: for `from base import
 * n`, the submodule `base.n` when there is one, else `base` itself.
 */
function imported(importer, { level, module, names }, index) {
  const base = absoluteName(importer, level, module);

  if (base === undefined) {
    return [];
  }

  const sub = (n) => (n === '*' ? undefined : index.get(`${base}.${n}`));
  const found =
    names.length === 0
      ? [index.get(base)]
      : names.map((n) => sub(n) ?? index.get(base));

  return found.filter((m) => m !== undefined);
}

/** True when `importer` is the package `name`'s `__init__.py` or a module inside it. */
function inside(importer, name) {
  return importer.name === name || importer.name.startsWith(`${name}.`);
}

/**
 * The package that `importer` may not import `target` from, or undefined
 * when the import is allowed: the outermost one, below the top level, that
 * holds `target` but not `importer`.
 */
function breach(importer, target, index) {
  const parts = target.name.split('.');

  for (let n = 2; n < parts.length; n += 1) {
    const pkg = index.get(parts.slice(0, n).join('.'));

    if (pkg?.isPackage && !inside(importer, pkg.name)) {
      return pkg;
    }
  }

  return undefined;
}

/** The modules in `index` that a file's imports load, each once. */
function targets(importer, index) {
  const found = pythonImports(importer.text).flatMap((statement) =>
    imported(importer, statement, index),
  );

  return [...new Set(found)];
}

/** One file's breaches as `{ path, rule, detail }`, one per imported module. */
function fileBreaches(importer, index) {
  return targets(importer, index).flatMap((target) => {
    const pkg = breach(importer, target, index);

    if (pkg === undefined) {
      return [];
    }

    const dir = pkg.path.replace(INIT, '');
    const detail = `imports ${target.path} from inside ${dir}/; import ${pkg.path} instead`;

    return [{ path: importer.path, rule: 'private', detail }];
  });
}

/**
 * The private-package violations in the Python files of `sources`, each a
 * source root as `{ dir, files }` (files a Map of path to text, paths
 * relative to the repo).
 */
export function privatePackages(sources) {
  const all = modules(sources);
  // As on Python's path, the first root to hold a name wins.
  const index = new Map([...all].reverse().map((m) => [m.name, m]));

  return all.flatMap((importer) => fileBreaches(importer, index));
}
