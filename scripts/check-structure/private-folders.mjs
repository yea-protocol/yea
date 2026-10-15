/**
 * The private-folder rule (ADR-0001): the files in a module's folder `x/` may
 * be imported only by its entry file and by the other files in `x/`. A folder
 * is a module's when it has an entry file: `x.ts` beside it (any script or Vue
 * extension, any case, so `Landing.vue` fronts `landing/`) or `x/index.ts`
 * inside it. Other folders only group files, and anyone may import from them.
 * The rule reads relative imports in TS, JS and Vue files; imports that leave
 * the source root (another package, build output) aren't checked.
 */
import { posix } from 'node:path';

const SCRIPT = /\.(ts|mts|cts|js|mjs|cjs|vue)$/;

/** `from '…'`, `import '…'`, `import('…')` and `require('…')` of `./` or `../` paths. */
const RELATIVE =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])(\.\.?\/[^'"\n]*)\1/g;

/** The relative specifiers `text` imports, in order. */
function relativeImports(text) {
  return [...text.matchAll(RELATIVE)].map((m) => m[2]);
}

/** A file's name without its extensions, lowercased: `Landing.vue` is `landing`. */
function stem(path) {
  return posix.basename(path).replace(/\..*$/, '').toLowerCase();
}

/** True when `path` is the entry file beside folder `dir`. */
function besideEntry(path, dir) {
  return (
    posix.dirname(path) === posix.dirname(dir) &&
    stem(path) === posix.basename(dir).toLowerCase()
  );
}

/** Folder `dir`'s entry file among `paths`, or undefined for a plain folder. */
function entryOf(dir, paths) {
  const inside = (p) => posix.dirname(p) === dir && stem(p) === 'index';
  const scripts = paths.filter((p) => SCRIPT.test(p));

  return (
    scripts.find((p) => besideEntry(p, dir)) ?? scripts.find((p) => inside(p))
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

/** The folder an import of `target` reaches into: an `index` file stands for its folder. */
function reached(target) {
  const dir = posix.dirname(target);

  return stem(target) === 'index' ? posix.dirname(dir) : dir;
}

/**
 * The module folder that `path` may not import `target` from, with its entry
 * file, or undefined when the import is allowed.
 */
function breach(path, target, paths) {
  for (const dir of entered(posix.dirname(path), reached(target))) {
    const entry = entryOf(dir, paths);

    if (entry !== undefined && !besideEntry(path, dir)) {
      return { dir, entry };
    }
  }

  return undefined;
}

/** One file's breaches as `{ path, rule, detail }`, one per imported target. */
function fileBreaches(root, path, text, paths) {
  const targets = new Set(
    relativeImports(text)
      .map((spec) => posix.normalize(posix.join(posix.dirname(path), spec)))
      .filter((target) => target.startsWith(`${root}/`)),
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
