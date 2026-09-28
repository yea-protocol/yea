/**
 * What a job server trusts, and where it comes from (SPEC-mcp-ts `yea()`, SPEC-approval §2): the
 * server's own key, the pinned principal key, the signed policy grant, and the unsigned
 * tightening. The policy and tightening are read on every call, so a new grant applies without
 * a restart; the keys are read once.
 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Create the key file only if it doesn't exist (O_EXCL), private to this user; false if it did. */
function createKey(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const seed = b64u(globalThis.crypto.getRandomValues(new Uint8Array(32)));

  try {
    writeFileSync(path, `${seed}\n`, { flag: 'wx', mode: 0o600 });

    return true;
  } catch (e) {
    if (errno(e) === 'EEXIST') {
      return false;
    }

    throw e;
  }
}

/** Why an existing key file can't be used, or null. */
function unsafeKeyFile(path: string): string | null {
  const st = lstatSync(path);

  if (st.isSymbolicLink()) {
    return `${path} is a symlink`;
  }

  if (!st.isFile()) {
    return `${path} is not a regular file`;
  }

  // Group and other bits: a key others can read (or write) is not this server's alone.
  return process.platform !== 'win32' && (st.mode & 0o077) !== 0
    ? `${path} can be read by other users (chmod 600 it)`
    : null;
}

/**
 * The server's Ed25519 seed: created on first run with O_EXCL, mode 0600, in a 0700 directory.
 * A key file that is a symlink, readable by others, or not a seed is refused.
 */
export function loadServerSeed(path: string): string {
  createKey(path);

  const why = unsafeKeyFile(path);

  if (why) {
    throw new Error(`yea(): refusing the server key: ${why}`);
  }

  const seed = readFileSync(path, 'utf8').trim();

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
