/**
 * A FileStore's id (SPEC-approval §8): `<root>/id`, a store id and nothing else. Whichever process
 * needs it first makes it, once and whole; every other process that shares the root, and
 * `yea approve`, reads the same one.
 */
import { join } from 'node:path';
import { isStoreId, newStoreId } from '../store.js';
import { errno } from '../util.js';
import {
  createWhole,
  NotRegularFile,
  readRegular,
  writeAtomic,
} from './files.js';
import { acquire, release, stillHeld } from './lock.js';

const idPath = (root: string) => join(root, 'id');

/** What `link` fails with where the filesystem has no hard links: FAT, exFAT, many SMB shares. */
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EPERM', 'ENOSYS']);

/**
 * The text at `path`, or null if there's none. A file it won't read is a store error naming the
 * path; an fs error already names it, and keeps its code for `yea approve` to report.
 */
function readIdFile(path: string): string | null {
  try {
    return readRegular(path);
  } catch (e) {
    if (e instanceof NotRegularFile) {
      throw new Error(`can't read the store id at ${path}: ${e.message}`);
    }

    throw e;
  }
}

/** The id of the store at `root`, or null if none has been made; a store error if it isn't one. */
export function readStoreId(root: string): string | null {
  const path = idPath(root);
  const text = readIdFile(path);

  if (text !== null && !isStoreId(text)) {
    throw new Error(
      `${path} doesn't hold a store id, so this store can't be used`,
    );
  }

  return text;
}

/** The id of the store at `root`, made now if it has none: the first to make one wins. */
export async function ensureStoreId(root: string): Promise<string> {
  const id = readStoreId(root);

  if (id !== null) {
    return id;
  }

  const made = newStoreId();

  if (await createId(root, made)) {
    return made;
  }

  const theirs = readStoreId(root);

  if (theirs === null) {
    throw new Error(
      `the store id at ${idPath(root)} was removed as it was made`,
    );
  }

  return theirs;
}

/**
 * Make `<root>/id` hold `made`, once and whole; false if another process made one first. An fs
 * error is a store error naming the file, with the error as its cause.
 */
async function createId(root: string, made: string): Promise<boolean> {
  try {
    return await linkedOrLocked(root, made);
  } catch (e) {
    if (errno(e) === undefined) {
      throw e;
    }

    throw new Error(
      `can't make the store id at ${idPath(root)}: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

/** Link the id into place; where the filesystem has no hard links, make it under the lock. */
function linkedOrLocked(
  root: string,
  made: string,
): Promise<boolean> | boolean {
  try {
    return createWhole(idPath(root), made);
  } catch (e) {
    if (NO_HARD_LINKS.has(errno(e) ?? '')) {
      return createIdLocked(root, made);
    }

    throw e;
  }
}

/**
 * Where the filesystem has no hard links: under the lock file `<root>/id.lock`, look again, and
 * only if there's still no id, write it to a temp file and rename it into place. Still once,
 * since on such a filesystem every maker takes the lock first, and whole, since a rename is.
 */
async function createIdLocked(root: string, made: string): Promise<boolean> {
  const lock = `${idPath(root)}.lock`;
  const token = await acquire(lock);

  try {
    if (readStoreId(root) !== null) {
      return false;
    }

    // A lock broken as stale (a holder paused over 30 s) may have let another maker in.
    if (!stillHeld(lock, token)) {
      throw new Error(`lost the store id's lock (${lock}); no id was made`);
    }

    writeAtomic(idPath(root), made);

    return true;
  } finally {
    release(lock, token);
  }
}
