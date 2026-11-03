/**
 * The private-folder rule (ADR-0001) for Python: a module inside a package
 * may be imported only by the package's `__init__.py`, its entry, and by the
 * other modules in the package, nested ones included. So a subpackage's
 * `__init__.py` is open to the package around it, and its other modules
 * aren't. A top-level package (`yea`, `yea_mcp`) stands for its source root,
 * not a module, so its own modules are open to all, and a folder without an
 * `__init__.py` only groups files. A module or package whose name starts with
 * `_` is private to its parent all the same, top-level parent included.
 * Imports resolve by module name across every source root, as Python finds
 * them; the rest (the standard library, dependencies) isn't checked. Test
 * files aren't walked.
 */
import { pythonImports } from './python-imports.mjs';

const INIT = /(^|\/)__init__\.py$/;

/** The parts in a top-level package's name: it stands for its root, not a module. */
const TOP_LEVEL = 1;

/** The module a file under `root` holds, as `{ root, path, text, name, isPackage }`. */
function moduleOf(root, path, text) {
  const relative = path.slice(root.length + 1);
  const isPackage = INIT.test(relative);
  const name = relative
    .replace(INIT, '')
    .replace(/\.py$/, '')
    .replaceAll('/', '.');

  return { root, path, text, name, isPackage };
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

/** The package a relative import in `importer` starts from, as name parts. */
function anchor(importer, pkg) {
  const parts = (pkg ?? importer.name).split('.');

  return pkg !== undefined || importer.isPackage ? parts : parts.slice(0, -1);
}

/**
 * The name `<level dots><module>` gives inside `importer` (or inside
 * `package`, for `import_module`), or undefined past the top.
 */
function absoluteName(importer, { level, module, package: pkg }) {
  if (level === 0) {
    return module;
  }

  const parts = anchor(importer, pkg);
  const kept = parts.length - (level - 1);

  if (kept < 1) {
    return undefined;
  }

  return [...parts.slice(0, kept), module].filter((p) => p !== '').join('.');
}

/**
 * The modules in `index` an import statement loads: for `from base import
 * n`, the submodule `base.n` when there is one, else `base` itself. A name
 * that is both a submodule and something `base/__init__.py` defines counts as
 * the submodule, so the check fails closed.
 */
function imported(importer, statement, index) {
  const base = absoluteName(importer, statement);
  const { names } = statement;

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

/** True for a name a leading `_` makes private (`_json`), not a dunder (`__main__`). */
function isPrivateName(part) {
  return part.startsWith('_') && !/^__.*__$/.test(part);
}

/**
 * Why `importer` may not import `target`, or undefined when it may: the
 * outermost package that holds `target` but not `importer`, and either lies
 * below the top level or holds `target` under a `_` name. As `{ n, entry }`:
 * the package is the first `n` parts of `target`'s name, and `entry` is true
 * when its `__init__.py` is the way in.
 */
function breach(importer, target, index) {
  const parts = target.name.split('.');

  for (let n = 1; n < parts.length; n += 1) {
    const name = parts.slice(0, n).join('.');
    const entry = n > TOP_LEVEL && index.get(name)?.isPackage === true;

    if (!inside(importer, name) && (entry || isPrivateName(parts[n]))) {
      return { n, entry };
    }
  }

  return undefined;
}

/** What a breach says: the `__init__.py` to import instead, or the `_` name that closes it. */
function breachDetail(target, { n, entry }) {
  const parts = target.name.split('.');
  const dir = `${target.root}/${parts.slice(0, n).join('/')}`;

  return entry
    ? `imports ${target.path} from inside ${dir}/; import ${dir}/__init__.py instead`
    : `imports ${target.path}; the leading _ of ${parts[n]} makes it private to ${dir}/`;
}

/** The modules in `index` that a file's imports load, each once. */
function targets(importer, index) {
  const found = pythonImports(importer.text).flatMap((statement) =>
    imported(importer, statement, index),
  );

  return [...new Set(found)];
}

/** One file's breaches as `{ path, rule, target, detail }`, one per imported module. */
function fileBreaches(importer, index) {
  return targets(importer, index).flatMap((target) => {
    const found = breach(importer, target, index);

    if (found === undefined) {
      return [];
    }

    const detail = breachDetail(target, found);

    return [
      { path: importer.path, rule: 'private', target: target.path, detail },
    ];
  });
}

/**
 * The private-package violations in the Python files of `sources`, and in
 * those of `importers`, which only import (the examples). Each is a root as
 * `{ dir, files }`: files a Map of path to text, paths relative to the repo.
 */
export function privatePackages(sources, importers = []) {
  const all = modules(sources);
  // As on Python's path, the first root to hold a name wins.
  const index = new Map([...all].reverse().map((m) => [m.name, m]));

  return [...all, ...modules(importers)].flatMap((importer) =>
    fileBreaches(importer, index),
  );
}
