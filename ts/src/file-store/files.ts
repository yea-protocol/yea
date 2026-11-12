/**
 * The file operations the approval store is built from (SPEC-approval §8): private directories,
 * create-once, atomic writes, reading a file only if it's a regular one, and breaking a stale
 * file without removing a fresh one.
 */
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomId } from '../crypto.js';
import { readCapped } from '../key-file.js';
import { errno } from '../util.js';

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
    if (errno(e) === 'EEXIST') {
      return false;
    }

    throw e;
  }
}

/**
 * Create `path` holding `text` only if it doesn't exist, and whole: written to a uniquely named
 * temp file, then linked into place, which fails if the name exists. False if it did.
 */
export function createWhole(path: string, text: string): boolean {
  mkdirFor(path);

  const tmp = `${path}.${randomId('t')}.tmp`;

  writeFileSync(tmp, text, { flag: 'wx', mode: PRIVATE_FILE });

  try {
    linkSync(tmp, path);

    return true;
  } catch (e) {
    if (errno(e) === 'EEXIST') {
      return false;
    }

    throw e;
  } finally {
    rmSync(tmp, { force: true });
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
    if (errno(e) === 'ENOENT') {
      return null;
    }

    throw e;
  }
}

/** A file `readRegular` won't read: not a regular file, or too big. */
export class NotRegularFile extends Error {
  constructor(readonly tooBig = false) {
    super(tooBig ? 'over 64 KiB' : 'not a regular file');
  }
}

/**
 * The text of the regular file at `path`, or null if there's none. It's opened without following
 * a symlink and without blocking on a FIFO (O_NOFOLLOW, O_NONBLOCK), checked on the open file, and
 * read to at most 64 KiB, as a server key is. An fs error (a symlink is ELOOP) is thrown as it is;
 * anything else that isn't a regular file, or is longer, is a `NotRegularFile`.
 */
export function readRegular(path: string): string | null {
  let fd: number;

  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (e) {
    if (errno(e) === 'ENOENT') {
      return null;
    }

    throw e;
  }

  try {
    if (!fstatSync(fd).isFile()) {
      throw new NotRegularFile();
    }

    const text = readCapped(fd);

    if (text === null) {
      throw new NotRegularFile(true);
    }

    return text;
  } finally {
    closeSync(fd);
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
