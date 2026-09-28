/**
 * Where the Stripe key comes from: `STRIPE_SECRET_KEY_FILE`, a file only the server's OS user
 * can read, or `STRIPE_SECRET_KEY`. It is the opposite of the principal key file: the secret
 * must be readable by the server and nobody else.
 *
 * Whatever the server can read, an agent running as the same OS user can read too. Only a
 * separate OS user for the server, or a remote server, keeps the key from the agent.
 */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';

/** Stripe keys are one token of letters, digits and underscores. */
const KEY = /^[A-Za-z0-9_]{8,256}$/;

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

const uid = () =>
  typeof process.getuid === 'function' ? process.getuid() : -1;

/** Why an open key file can't be trusted, or null: another user's, or readable by others. */
function unsafe(path: string, fd: number, owner: number): string | null {
  const st = fstatSync(fd);

  if (!st.isFile()) {
    return `${path} is not a regular file`;
  }

  if (typeof process.getuid !== 'function') {
    // Windows: no uid or mode bits to check. Say so rather than pass silently.
    console.error(
      `yea-stripe: warning: can't check who owns ${path} or who can read it on this platform; keep it private yourself`,
    );

    return null;
  }

  if (st.uid !== owner) {
    return `${path} is not owned by the user running the server`;
  }

  return (st.mode & 0o077) !== 0
    ? `${path} can be read by other users (chmod 600 it)`
    : null;
}

/** A key as the file or variable holds it, checked so it can't smuggle anything into a header. */
function checkKey(key: string, from: string): string {
  const k = key.trim();

  if (!KEY.test(k)) {
    throw new Error(`${from} does not hold a Stripe key (sk_… or rk_…)`);
  }

  return k;
}

/**
 * Open without following a symlink (O_NOFOLLOW), then check and read that same file. `owner` is
 * the user the file must belong to: the one running the server.
 */
export function readKeyFile(path: string, owner = uid()): string {
  let fd: number;

  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    throw new Error(
      `refusing STRIPE_SECRET_KEY_FILE: ${errno(e) === 'ELOOP' ? `${path} is a symlink` : (e as Error).message}`,
    );
  }

  try {
    const why = unsafe(path, fd, owner);

    if (why) {
      throw new Error(`refusing STRIPE_SECRET_KEY_FILE: ${why}`);
    }

    return checkKey(readFileSync(fd, 'utf8'), path);
  } finally {
    closeSync(fd);
  }
}

/**
 * The Stripe key: the file `STRIPE_SECRET_KEY_FILE` names, checked, else `STRIPE_SECRET_KEY`.
 * A file that fails its check is refused, never skipped for the variable.
 */
export function readSecretKey(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STRIPE_SECRET_KEY_FILE) {
    return readKeyFile(env.STRIPE_SECRET_KEY_FILE);
  }

  if (env.STRIPE_SECRET_KEY) {
    return checkKey(env.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY');
  }

  throw new Error(
    'set STRIPE_SECRET_KEY_FILE (a file only you can read: chmod 600) or STRIPE_SECRET_KEY',
  );
}
