/**
 * The private-folder rule (ADR-0001): the files in a module's folder `x/` may
 * be imported only by its entry file `x.ts` beside it and by the other files
 * in `x/`. A folder is a module's when it has that entry file (any script or
 * Vue extension, any case, so `Landing.vue` fronts `landing/`); other folders
 * only group files, and any file may import from them. The rule reads the
 * relative imports in the code of TS, JS and Vue files, not in comments, and
 * leaves alone imports that leave the source root (another package, build
 * output). Test files aren't walked, so they never act as an entry.
 */
import { posix } from 'node:path';
import { codeOf } from './code.mjs';

const SCRIPT = /\.(ts|mts|cts|js|mjs|cjs|vue)$/;

/** `from '…'`, `import '…'`, `import('…')` and `require('…')` of `./` or `../` paths. */
const RELATIVE =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])(\.\.?\/[^'"\n]*)\1/g;

/** The source a compiled specifier names: `x.js` may be `x.ts`. */
const SOURCES = { '.js': ['.ts'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/** The relative specifiers the code of the file at `path` imports, in order. */
function relativeImports(path, text) {
  return [...codeOf(path, text).matchAll(RELATIVE)].map((m) => m[2]);
}

/** A file's name without its last extension, lowercased: `Landing.vue` is `landing`. */
function stem(path) {
  return posix
    .basename(path)
    .replace(/\.[^.]*$/, '')
    .toLowerCase();
}

/** True when `path` is the entry file beside folder `dir`. */
function isEntry(path, dir) {
  return (
    SCRIPT.test(path) &&
    posix.dirname(path) === posix.dirname(dir) &&
    stem(path) === posix.basename(dir).toLowerCase()
  );
}

/** The folders `to` lies in that `from` doesn't, outermost first. */
function entered(from, to) {
  const a = from.split('/');
  const b = to.split('/');
  const shared = b.findIndex((part, i) => part !== a[i]);

  if (shared < 0) {
    return [];
  }

  return b.slice(shared).map((_, i) => b.slice(0, shared + i + 1).join('/'));
}

/**
 * The module folder that `path` may not import `target` from, with its entry
 * file, or undefined when the import is allowed.
 */
function breach(path, target, paths) {
  for (const dir of entered(posix.dirname(path), posix.dirname(target))) {
    const entry = paths.find((p) => isEntry(p, dir));

    if (entry !== undefined && !isEntry(path, dir)) {
      return { dir, entry };
    }
  }

  return undefined;
}

/** The file `target` names among `paths`: itself, or its source for a `.js` name. */
function resolve(target, paths) {
  const ext = posix.extname(target);
  const base = target.slice(0, target.length - ext.length);
  const found = (SOURCES[ext] ?? [])
    .map((source) => `${base}${source}`)
    .find((p) => paths.includes(p));

  return found ?? target;
}

/** One file's breaches as `{ path, rule, detail }`, one per imported file. */
function fileBreaches(root, path, text, paths) {
  const targets = new Set(
    relativeImports(path, text)
      .map((spec) => posix.normalize(posix.join(posix.dirname(path), spec)))
      .filter((target) => target.startsWith(`${root}/`))
      .map((target) => resolve(target, paths)),
  );

  return [...targets].flatMap((target) => {
    const found = breach(path, target, paths);

    return found === undefined
      ? []
      : [
          {
            path,
            rule: 'private',
            detail: `imports ${target} from inside ${found.dir}/; import ${found.entry} instead`,
          },
        ];
  });
}

/**
 * The private-folder violations among `files` (a Map of path to text, paths
 * relative to the repo), all under the source root `root`.
 */
export function privateFolders(root, files) {
  const paths = [...files.keys()];

  return [...files]
    .filter(([path]) => SCRIPT.test(path))
    .flatMap(([path, text]) => fileBreaches(root, path, text, paths));
}
