/**
 * The server's own name and key (SPEC-mcp-ts `yea()`): the name checked, and the Ed25519 seed,
 * created on first run and read once through `@yea-protocol/sdk/node`'s key-file checks.
 */
import {
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { b64u } from '@yea-protocol/sdk';
import {
  checkServerKeyDir,
  readServerSeed,
  SERVER_NAME,
} from '@yea-protocol/sdk/node';
import { errno, errorMessage } from './util.js';

/** Server names name a key file and appear in consent codes. */
export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !SERVER_NAME.test(name)) {
    throw new TypeError(
      `yea(): name must match [a-z0-9._-]{1,64}, got ${JSON.stringify(name)}`,
    );
  }

  return name;
}

/**
 * Create the key file only if it doesn't exist, private to this user. The seed is written to a
 * temp file first and linked into place (which fails if the key exists, like O_EXCL), so a
 * concurrent reader never sees an empty key.
 */
function createKey(path: string) {
  const seed = b64u(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const tmp = `${path}.${b64u(globalThis.crypto.getRandomValues(new Uint8Array(9)))}.tmp`;

  writeFileSync(tmp, `${seed}\n`, { flag: 'wx', mode: 0o600 });

  try {
    linkSync(tmp, path);
  } catch (e) {
    if (errno(e) !== 'EEXIST') {
      throw e;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * The server's Ed25519 seed: created on first run, mode 0600, in a 0700 directory. A key file
 * that is a symlink, someone else's, readable by others, or not a seed is refused, and so is a
 * key directory others can write.
 */
export function loadServerSeed(path: string): string {
  const dir = dirname(path);

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const why = checkServerKeyDir(dir);

  if (why) {
    throw new Error(`yea(): refusing the server key: ${why}`);
  }

  // A dangling symlink doesn't exist either: linking fails on it, and reading refuses it.
  if (!existsSync(path)) {
    createKey(path);
  }

  try {
    return readServerSeed(path);
  } catch (e) {
    throw new Error(`yea(): ${errorMessage(e)}`, { cause: e });
  }
}
