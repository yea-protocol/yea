/**
 * What a job server trusts, and where it comes from (SPEC-mcp-ts `yea()`, SPEC-approval §2): the
 * server's own key, the pinned principal key, the signed policy grant, and the unsigned
 * tightening. The policy and tightening are read on every call, so a new grant applies without
 * a restart; the keys are read once.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  atLeast,
  b64u,
  type Risk,
  readTightening,
  type Tightening,
} from '@yea-protocol/sdk';
import { home, readPinnedKey } from '@yea-protocol/sdk/node';

const NAME = /^[a-z0-9._-]{1,64}$/;
const SEED = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_KEY = /^ed25519:[A-Za-z0-9_-]{43}$/;

/** Server names name a key file and appear in consent codes. */
export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError(
      `yea(): name must match [a-z0-9._-]{1,64}, got ${JSON.stringify(name)}`,
    );
  }

  return name;
}

export const defaultKeyPath = (name: string) =>
  join(home(), 'server', `${name}.key`);

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

const POSIX = typeof process.getuid === 'function';
const uid = () => (POSIX && process.getuid ? process.getuid() : -1);

/**
 * Why the key's directory can't be trusted, or null: it must be this user's, and not writable by
 * group or others (who could replace the key file).
 */
function unsafeKeyDir(dir: string): string | null {
  const st = statSync(dir);

  if (!st.isDirectory()) {
    return `${dir} is not a directory`;
  }

  if (!POSIX) {
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

/** Why an open key file can't be used, or null. */
function unsafeKeyFile(path: string, fd: number): string | null {
  const st = fstatSync(fd);

  if (!st.isFile()) {
    return `${path} is not a regular file`;
  }

  if (!POSIX) {
    return null;
  }

  if (st.uid !== uid()) {
    return `${path} is not owned by this user`;
  }

  // Group and other bits: a key others can read (or write) is not this server's alone.
  return (st.mode & 0o077) !== 0
    ? `${path} can be read by other users (chmod 600 it)`
    : null;
}

/** Open the key without following a symlink (O_NOFOLLOW), then check and read that same file. */
function readKeyFile(path: string): string {
  let fd: number;

  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    throw new Error(
      `yea(): refusing the server key: ${errno(e) === 'ELOOP' ? `${path} is a symlink` : (e as Error).message}`,
    );
  }

  try {
    const why = unsafeKeyFile(path, fd);

    if (why) {
      throw new Error(`yea(): refusing the server key: ${why}`);
    }

    return readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
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

  const why = unsafeKeyDir(dir);

  if (why) {
    throw new Error(`yea(): refusing the server key: ${why}`);
  }

  // A dangling symlink doesn't exist either: linking fails on it, and reading refuses it.
  if (!existsSync(path)) {
    createKey(path);
  }

  const seed = readKeyFile(path);

  if (!SEED.test(seed)) {
    throw new Error(`yea(): ${path} does not hold an Ed25519 seed`);
  }

  return seed;
}

export type Pinned = { key: string } | { why: string };

/** The pinned principal public key: the option if given, else `YEA_PRINCIPAL_PUB`, checked. */
export function pinnedPrincipal(option: string | undefined): Pinned {
  if (option === undefined) {
    return readPinnedKey();
  }

  return PUBLIC_KEY.test(option)
    ? { key: option }
    : { why: 'the principal option is not an ed25519 public key' };
}

const warned = new Set<string>();

/** Warn on stderr, once per message, so a per-call read doesn't flood the log. */
export function warnOnce(message: string) {
  if (!warned.has(message)) {
    warned.add(message);
    console.error(`yea: ${message}`);
  }
}

/** Read a file, or null if it doesn't exist; other errors are reported and read as absent. */
function readIfThere(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (errno(e) !== 'ENOENT') {
      warnOnce(`can't read ${path}: ${(e as Error).message}`);
    }

    return null;
  }
}

/**
 * The signed policy grant for this call: the option, else `YEA_POLICY`. A value starting with
 * `pg1.` is the token; anything else is a path to one. Null means nothing auto-runs.
 */
export function readPolicy(option: string | undefined): string | null {
  const value = option ?? process.env.YEA_POLICY;

  if (!value) {
    return null;
  }

  if (value.startsWith('pg1.')) {
    return value;
  }

  const token = readIfThere(value)?.trim() ?? null;

  if (token === null || !token.startsWith('pg1.')) {
    warnOnce(`${value} does not hold a pg1. policy grant; nothing auto-runs`);

    return null;
  }

  return token;
}

/** The unsigned rules in `~/.yea/policy.json`; a missing file is the defaults. */
function fileTightening(): Tightening | null {
  const text = readIfThere(join(home(), 'policy.json'));

  if (text === null) {
    return null;
  }

  try {
    return readTightening(JSON.parse(text));
  } catch {
    return readTightening(null);
  }
}

const stricter = (a: Risk, b: Risk): Risk => (atLeast(a, b) ? b : a);

/** The option and `~/.yea/policy.json` merged: `deny` is the union, `outOfBand` the stricter. */
export function readTighteningFor(option: unknown): {
  deny: string[];
  outOfBand: Risk;
} {
  const fromOption = readTightening(option);
  const fromFile = fileTightening();
  const all = fromFile ? [fromOption, fromFile] : [fromOption];

  for (const w of all.flatMap((t) => t.warnings)) {
    warnOnce(`policy: ${w}`);
  }

  return {
    deny: [...new Set(all.flatMap((t) => t.deny))],
    outOfBand: all.map((t) => t.outOfBand).reduce(stricter),
  };
}
