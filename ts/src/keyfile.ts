/**
 * Reading a secret that only this OS user may see: a server's Ed25519 seed or a connector's API
 * key. The file is opened once without following a symlink, and the checks run on that open
 * file, so it can't be swapped between the check and the read. It is the opposite of the pinned
 * principal key (`checkKeyFile`), which this user must *not* be able to change.
 * Node only; exported from `@yea-protocol/sdk/node`.
 */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { home } from './home.js';

/** Server names name a key file (`~/.yea/server/<name>.key`) and appear in consent codes. */
export const SERVER_NAME = /^[a-z0-9._-]{1,64}$/;

/** An Ed25519 seed as a key file holds it: 32 bytes, b64url. */
const SEED = /^[A-Za-z0-9_-]{43}$/;

/** This process's OS user id, or -1 where the platform has none (Windows). */
export const uid = () =>
  typeof process.getuid === 'function' ? process.getuid() : -1;

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

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** Why an open private file can't be trusted, or null. */
function unsafePrivateFile(
  path: string,
  fd: number,
  owner: number,
): string | null {
  const st = fstatSync(fd);

  if (!st.isFile()) {
    return `${path} is not a regular file`;
  }

  if (typeof process.getuid !== 'function') {
    // Windows has no uid or mode bits to check. Say so rather than pass silently; refusing
    // would make every server unusable there.
    console.error(
      `yea: warning: can't check who owns ${path} or who can read it on this platform; keep it private yourself`,
    );

    return null;
  }

  if (st.uid !== owner) {
    return `${path} is not owned by this user`;
  }

  // Group and other bits: a secret others can read (or write) is not this user's alone.
  return (st.mode & 0o077) !== 0
    ? `${path} can be read by other users (chmod 600 it)`
    : null;
}

/** Open `path` read-only without following a symlink (O_NOFOLLOW). */
function openNoFollow(path: string, label: string): number {
  try {
    return openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    const why =
      errno(e) === 'ELOOP' ? `${path} is a symlink` : (e as Error).message;

    throw new Error(`refusing ${label}: ${why}`, { cause: e });
  }
}

/**
 * The text of a file only this user may read: not a symlink, a regular file, owned by `owner`,
 * and no group or other permission bits (0600 or 0400). It is opened once (O_NOFOLLOW) and the
 * checks run on that descriptor, so the file read is the file checked. Throws
 * `refusing <label>: <why>`; a missing file's error has the ENOENT error as its `cause`.
 */
export function readPrivateFile(
  path: string,
  { label, owner = uid() }: PrivateFileOptions,
): string {
  const fd = openNoFollow(path, label);

  try {
    const why = unsafePrivateFile(path, fd, owner);

    if (why) {
      throw new Error(`refusing ${label}: ${why}`);
    }

    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
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
