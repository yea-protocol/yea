/**
 * A FileStore's id (SPEC-approval §8): `<root>/id`, a store id and nothing else. Whichever process
 * needs it first makes it, once and whole; every other process that shares the root, and
 * `yea approve`, reads the same one.
 */
import { join } from 'node:path';
import { isStoreId, newStoreId } from '../store.js';
import { createWhole, NotRegularFile, readRegular } from './files.js';

const idPath = (root: string) => join(root, 'id');

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

/** The id of the store at `root`, made now if it has none: the first to link one in wins. */
export function ensureStoreId(root: string): string {
  const id = readStoreId(root);

  if (id !== null) {
    return id;
  }

  const made = newStoreId();

  if (createWhole(idPath(root), made)) {
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
