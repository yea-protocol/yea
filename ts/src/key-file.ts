/**
 * Reading a secret that only this OS user may see: a server's Ed25519 seed or a connector's API
 * key. The file is opened once without following a symlink, and the checks run on that open
 * file, so it can't be swapped between the check and the read. It is the opposite of the pinned
 * principal key (`checkKeyFile`, pinned-key.ts), which this user must *not* be able to change.
 * Node only; exported from `@yea-protocol/sdk/node`.
 */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { home } from './home.js';

/** Server names name a key file (`~/.yea/server/<name>.key`) and appear in consent codes. */
export const SERVER_NAME = /^[a-z0-9._-]{1,64}$/;

/** An Ed25519 seed as a key file holds it: 32 bytes, b64url. */
const SEED = /^[A-Za-z0-9_-]{43}$/;

/** Seeds are 44 bytes and API keys a few hundred; anything this big is not a key file. */
const MAX_PRIVATE_FILE = 64 * 1024;

/** Whether this platform has OS user ids and mode bits to check (not Windows). */
export const canCheckOwners = () => typeof process.getuid === 'function';

/** This process's OS user id, or -1 where the platform has none (Windows). */
export const uid = () => process.getuid?.() ?? -1;

/** Where the server named `name` keeps its seed: `~/.yea/server/<name>.key`. */
export const serverKeyPath = (name: string) =>
  join(home(), 'server', `${name}.key`);

/** How `readPrivateFile` names the file in errors, and who must own it. */
export interface PrivateFileOptions {
  /** What the file is, for errors: `refusing <label>: <why>`. */
  label: string;
  /** The OS user id that must own the file; this process's by default. */
  owner?: number;
}

const tooBig = (path: string) =>
  `${path} is larger than 64 KiB, too big for a key file`;

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** Why the owner and mode of an open private file can't be trusted, or null. */
function unsafeOwnerOrMode(
  path: string,
  st: { uid: number; mode: number },
  owner: number | undefined,
): string | null {
  if (!canCheckOwners()) {
    // Windows has no uid or mode bits to check. Say so rather than pass silently; refusing
    // would make every server unusable there. stderr, so a stdio MCP stream stays clean.
    console.error(
      `yea: warning: can't check who owns ${path} or who can read it on this platform; keep it private yourself`,
    );

    return null;
  }

  if (st.uid !== (owner ?? uid())) {
    return `${path} is not owned by ${owner === undefined ? 'this user' : `uid ${owner}`}`;
  }

  // Group and other bits: a secret others can read (or write) is not this user's alone.
  return (st.mode & 0o077) !== 0
    ? `${path} can be read by other users (chmod 600 it)`
    : null;
}

/** Why an open private file can't be trusted, or null. */
function unsafePrivateFile(
  path: string,
  fd: number,
  owner: number | undefined,
): string | null {
  const st = fstatSync(fd);

  if (!st.isFile()) {
    return `${path} is not a regular file`;
  }

  if (st.size > MAX_PRIVATE_FILE) {
    return tooBig(path);
  }

  return unsafeOwnerOrMode(path, st, owner);
}

/**
 * Open `path` read-only without following a symlink (O_NOFOLLOW). O_NONBLOCK keeps a FIFO from
 * blocking the open forever; fstat then refuses it as not a regular file.
 */
function openNoFollow(path: string, label: string): number {
  const flags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0);

  try {
    return openSync(path, flags);
  } catch (e) {
    const why =
      errno(e) === 'ELOOP' ? `${path} is a symlink` : (e as Error).message;

    throw new Error(`refusing ${label}: ${why}`, { cause: e });
  }
}

/**
 * Read at most MAX_PRIVATE_FILE bytes from `fd`; null if there are more. fstat's size is only a
 * snapshot, so a file that grows after the check still can't be read past the cap.
 */
function readCapped(fd: number): string | null {
  const buf = Buffer.alloc(MAX_PRIVATE_FILE + 1);
  let total = 0;

  for (;;) {
    const n = readSync(fd, buf, total, buf.length - total, null);

    if (n === 0) {
      return buf.toString('utf8', 0, total);
    }

    total += n;

    if (total > MAX_PRIVATE_FILE) {
      return null;
    }
  }
}

/**
 * The text of a file only this user may read: not a symlink, a regular file of at most 64 KiB,
 * owned by `owner`, and no group or other permission bits (0600 or 0400). It is opened once
 * (O_NOFOLLOW) and the checks run on that descriptor, so the file read is the file checked.
 * Throws `refusing <label>: <why>`; a missing file's error has the ENOENT error as its `cause`.
 * Where owners can't be checked (Windows) it warns on stderr and reads the file.
 */
export function readPrivateFile(
  path: string,
  { label, owner }: PrivateFileOptions,
): string {
  const fd = openNoFollow(path, label);

  try {
    const why = unsafePrivateFile(path, fd, owner);

    if (why) {
      throw new Error(`refusing ${label}: ${why}`);
    }

    const text = readCapped(fd);

    if (text === null) {
      throw new Error(`refusing ${label}: ${tooBig(path)}`);
    }

    return text;
  } finally {
    closeSync(fd);
  }
}

/**
 * Why the directory holding a server key can't be trusted, or null: it must be this user's,
 * and not writable by group or others (who could replace the key file).
 */
function unsafeKeyDir(dir: string): string | null {
  const st = statSync(dir);

  if (!st.isDirectory()) {
    return `${dir} is not a directory`;
  }

  if (!canCheckOwners()) {
    return null;
  }

  if (st.uid !== uid()) {
    return `${dir} is not owned by this user`;
  }

  return (st.mode & 0o022) !== 0
    ? `${dir} can be written by other users (chmod 700 it)`
    : null;
}

/**
 * Whoever can write the key directory's parent can swap the key directory for their own. So
 * the parent must be owned by this user or root, and not writable by others unless it has the
 * sticky bit (like /tmp), which stops them renaming a directory they don't own.
 */
function unsafeParentDir(dir: string): string | null {
  if (!canCheckOwners()) {
    return null;
  }

  const st = statSync(dir);
  const owner = st.uid === uid() || st.uid === 0;
  const othersWrite = (st.mode & 0o022) !== 0;
  const sticky = (st.mode & 0o1000) !== 0;

  if (!owner) {
    return `${dir} is owned by another user`;
  }

  return othersWrite && !sticky
    ? `${dir} can be written by other users (chmod 755 it)`
    : null;
}

/**
 * Why the directory `dir` holding a server key (or its parent) can't be trusted, or null.
 * Throws the `statSync` error if `dir` doesn't exist.
 */
export function checkServerKeyDir(dir: string): string | null {
  return unsafeKeyDir(dir) ?? unsafeParentDir(dirname(dir));
}

/**
 * The Ed25519 seed in a server key file, read with `readPrivateFile`. This is the check the MCP
 * server applies to its own key, so `yea service-id` prints the id the server really uses.
 */
export function readServerSeed(path: string): string {
  const seed = readPrivateFile(path, { label: 'the server key' }).trim();

  if (!SEED.test(seed)) {
    throw new Error(`${path} does not hold an Ed25519 seed`);
  }

  return seed;
}
