/**
 * The file operations the approval store is built from (SPEC-approval §8): private directories,
 * create-once, atomic writes, and breaking a stale file without removing a fresh one.
 */
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomId } from '../crypto.js';

/** Store directories and files are this user's alone, as Python's store makes them. */
const PRIVATE = 0o700;
const PRIVATE_FILE = 0o600;

const mkdirFor = (path: string) =>
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE });

/** Create `path` only if it doesn't exist (O_EXCL); false if it did. */
export function createOnce(path: string, text = ''): boolean {
  mkdirFor(path);

  try {
    writeFileSync(path, text, { flag: 'wx', mode: PRIVATE_FILE });

    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }

    throw e;
  }
}

/** Write via a uniquely named temp file and rename, so a reader never sees half a file. */
export function writeAtomic(path: string, text: string) {
  mkdirFor(path);

  const tmp = `${path}.${randomId('t')}.tmp`;

  writeFileSync(tmp, text, { flag: 'wx', mode: PRIVATE_FILE });
  renameSync(tmp, path);
}

export function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw e;
  }
}

/**
 * Remove `path` if it's older than `ageMs`, without ever removing a fresh one someone else just
 * created: read its contents (a random token) first, move it aside, and delete it only if the
 * moved file still holds that token. Otherwise put it back and leave it.
 */
export function breakIfStale(path: string, ageMs: number) {
  let seen: string | null;

  try {
    if (Date.now() - statSync(path).mtimeMs <= ageMs) {
      return;
    }

    seen = readOrNull(path);
  } catch {
    return; // already gone
  }

  const aside = `${path}.${randomId('s')}.stale`;

  try {
    renameSync(path, aside);
  } catch {
    return; // someone else moved it first
  }

  if (seen !== null && readOrNull(aside) === seen) {
    rmSync(aside, { force: true });

    return;
  }

  // We moved a fresh file: put it back unless another has taken its place.
  try {
    linkSync(aside, path);
  } catch {
    // a newer one exists; the moved file's owner sees its token gone and fails closed
  }

  rmSync(aside, { force: true });
}
