/**
 * A tarball against the workspace it was packed from: every file under each
 * folder the package's `files` names made it in, so a file only a dynamic
 * import reaches, or one a stray .npmignore drops, can't go missing unseen.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** True when `path` is a folder. */
function isFolder(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every file under `folder` in the package at `dir`, relative to `dir`. */
function filesUnder(dir, folder) {
  return readdirSync(join(dir, folder), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/**
 * A line for each file under a `files` folder of the package at `dir` that
 * isn't among `packed`, the paths `npm pack --json` lists for its tarball.
 */
export function unpackedFiles(dir, packed) {
  const { name, files = [] } = JSON.parse(
    readFileSync(join(dir, 'package.json'), 'utf8'),
  );
  const inTarball = new Set(packed);

  return files
    .filter((entry) => isFolder(join(dir, entry)))
    .flatMap((folder) => filesUnder(dir, folder))
    .filter((path) => !inTarball.has(path))
    .map((path) => `${name}: ${path} isn't in the tarball`);
}
