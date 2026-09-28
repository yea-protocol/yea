/**
 * The check on the pinned principal key (SPEC-approval §2): neither its file nor any directory
 * above it may be changeable by the server's OS user. The opposite of key-file.ts, whose files
 * only this user may see. Node only; exported from `@yea-protocol/sdk/node`.
 */
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isPublicKey } from './grants.js';
import { canCheckOwners, uid } from './key-file.js';

/** Whether this OS user could change `path`: owns it, or can write it. */
function changeable(path: string): boolean {
  if (statSync(path).uid === uid() || lstatSync(path).uid === uid()) {
    return true;
  }

  try {
    accessSync(path, constants.W_OK);

    return true;
  } catch {
    return false;
  }
}

/**
 * Why the principal key file can't be trusted, or null. Neither the file nor any directory
 * above it may be owned or writable by the server's OS user, or the agent could swap the key.
 */
export function checkKeyFile(path: string): string | null {
  if (!canCheckOwners()) {
    return "can't check who owns the principal key file on this platform";
  }

  if (uid() === 0) {
    return 'refusing to trust a principal key file while running as root: run the server as its own user';
  }

  let real: string;

  try {
    real = realpathSync(path);
  } catch {
    return `${path} can't be read`;
  }

  // Both the path as given (a symlink's own directory) and where it really leads.
  return unchangeableChain(resolve(path)) ?? unchangeableChain(real);
}

/** Why `path` or a directory above it could be changed by this user, or null. */
function unchangeableChain(path: string): string | null {
  let p = path;

  for (;;) {
    try {
      if (changeable(p)) {
        return `${p} can be changed by this user, so the agent could replace the principal key`;
      }
    } catch {
      return `${p} can't be read`;
    }

    const up = dirname(p);

    if (up === p) {
      return null;
    }

    p = up;
  }
}

/** The pinned principal public key from `YEA_PRINCIPAL_PUB`, or why there isn't a usable one. */
export function readPinnedKey(
  path = process.env.YEA_PRINCIPAL_PUB,
): { key: string } | { why: string } {
  if (!path) {
    return { why: 'YEA_PRINCIPAL_PUB is not set' };
  }

  const why = checkKeyFile(path);

  if (why) {
    return { why };
  }

  const key = readFileSync(path, 'utf8').trim();

  return isPublicKey(key)
    ? { key }
    : { why: `${path} does not hold an ed25519 public key` };
}
