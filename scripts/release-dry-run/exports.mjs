/**
 * An installed package's `exports`, checked the way an adopter meets them:
 * every file an entry points at (types too) is in the tarball, and every entry
 * loads with `import` and with `require`, each in a fresh Node.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh } from './shell.mjs';

/**
 * Entries only `import` can load: the CLI dispatcher runs behind a top-level
 * await, which require(esm) refuses (#327).
 */
const ESM_ONLY = new Set(['@yea-protocol/sdk/cli']);

/** The package's `exports` as a map of subpath to target. */
function subpaths(exports) {
  const keyed =
    typeof exports === 'object' &&
    exports !== null &&
    Object.keys(exports).every((key) => key.startsWith('.'));

  return keyed ? exports : { '.': exports };
}

/** Every file path in a target: a string, or conditions holding more. */
function targetFiles(target) {
  if (typeof target === 'string') {
    return [target];
  }

  if (target === null || typeof target !== 'object') {
    return [];
  }

  return Object.values(target).flatMap(targetFiles);
}

/** The package at `dir`: its name and its entries, each with its files. */
function entriesOf(dir) {
  const { name, exports = {} } = JSON.parse(
    readFileSync(join(dir, 'package.json'), 'utf8'),
  );

  return Object.entries(subpaths(exports)).map(([subpath, target]) => ({
    specifier: subpath === '.' ? name : `${name}${subpath.slice(1)}`,
    files: targetFiles(target),
  }));
}

/** A line for each file an entry of the package at `dir` points at but lacks. */
function missingFiles(dir) {
  return entriesOf(dir).flatMap(({ specifier, files }) =>
    files
      .filter((file) => !existsSync(join(dir, file)))
      .map((file) => `${specifier}: ${file} isn't in the package`),
  );
}

/** Node's error when it runs `args` in `cwd`, or undefined when it succeeds. */
function failure(cwd, args) {
  try {
    sh(process.execPath, args, { cwd });

    return undefined;
  } catch (error) {
    const lines = error.message.split('\n');

    return lines.find((line) => /Error\b/.test(line)) ?? lines[0];
  }
}

/**
 * A line for each way `specifier` fails to load from the project in `cwd`:
 * by `import`, and by `require` unless it's ESM-only.
 */
function loadFailures(cwd, specifier) {
  const name = JSON.stringify(specifier);
  const imported = failure(cwd, [
    '--input-type=module',
    '-e',
    `await import(${name})`,
  ]);
  const required = ESM_ONLY.has(specifier)
    ? undefined
    : failure(cwd, ['-e', `require(${name})`]);

  return [
    imported && `import ${specifier}: ${imported}`,
    required && `require ${specifier}: ${required}`,
  ].filter(Boolean);
}

/**
 * Every problem with the exports of `pkg`, installed in the project at `app`:
 * files missing from the tarball, then entries that don't load.
 */
export function exportProblems(app, pkg) {
  const dir = join(app, 'node_modules', pkg);

  return [
    ...missingFiles(dir),
    ...entriesOf(dir).flatMap(({ specifier }) => loadFailures(app, specifier)),
  ];
}
