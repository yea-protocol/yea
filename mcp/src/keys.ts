/**
 * What a job server trusts, and where it comes from (SPEC-mcp-ts `yea()`, SPEC-approval §2): the
 * server's own key, the pinned principal key, the signed policy grant, and the unsigned
 * tightening. The policy and tightening are read on every call, so a new grant applies without
 * a restart; the keys are read once.
 */
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  atLeast,
  b64u,
  isPublicKey,
  isRisk,
  type Risk,
  readTightening,
  type Tightening,
} from '@yea-protocol/sdk';
import {
  checkServerKeyDir,
  home,
  readPinnedKey,
  readServerSeed,
  SERVER_NAME,
} from '@yea-protocol/sdk/node';
import { errorMessage, warnOnce } from './util.js';

/** Server names name a key file and appear in consent codes. */
export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !SERVER_NAME.test(name)) {
    throw new TypeError(
      `yea(): name must match [a-z0-9._-]{1,64}, got ${JSON.stringify(name)}`,
    );
  }

  return name;
}

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

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

export type Pinned = { key: string } | { why: string };

/** The pinned principal public key: the option if given, else `YEA_PRINCIPAL_PUB`, checked. */
export function pinnedPrincipal(option: string | undefined): Pinned {
  if (option === undefined) {
    return readPinnedKey();
  }

  return isPublicKey(option)
    ? { key: option }
    : { why: 'the principal option is not an ed25519 public key' };
}

/** Read a file, or null if it doesn't exist; other errors are reported and read as absent. */
function readIfThere(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (errno(e) !== 'ENOENT') {
      warnOnce(`can't read ${path}: ${errorMessage(e)}`);
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

/** The unsigned rules in a policy file, or why the file can't be used. */
function parseTightening(
  path: string,
  text: string,
): { t: Tightening } | { broken: string } {
  let v: unknown;

  try {
    v = JSON.parse(text);
  } catch {
    return { broken: `${path} is not valid JSON` };
  }

  const t = readTightening(v);
  // Unknown fields only warn; a policy we can't read, or a bad deny or outOfBand, fails closed.
  const bad = t.warnings.find((w) => /not a JSON object|bad value/.test(w));

  return bad ? { broken: `${path}: ${bad}` } : { t };
}

/**
 * The unsigned rules in `~/.yea/policy.json`: null when there is no file. A file that can't be
 * read or parsed is `broken`, and job calls refuse: its `deny` can't be known.
 */
function fileTightening(): { t: Tightening } | { broken: string } | null {
  const path = join(home(), 'policy.json');
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return errno(e) === 'ENOENT'
      ? null
      : { broken: `can't read ${path}: ${errorMessage(e)}` };
  }

  return parseTightening(path, text);
}

/** The stricter floor; an unvalidated value that isn't a risk wins, so it can't loosen. */
export const stricter = (a: Risk, b: Risk): Risk =>
  !isRisk(a) ? a : !isRisk(b) ? b : atLeast(a, b) ? b : a;

/** Unsigned tightening as a call applies it; `broken` says why job calls must refuse. */
export interface Rules {
  deny: string[];
  outOfBand: Risk;
  broken: string | null;
}

/** The option and `~/.yea/policy.json` merged: `deny` is the union, `outOfBand` the stricter. */
export function readTighteningFor(option: unknown): Rules {
  const fromOption = readTightening(option);
  const file = fileTightening();
  const fromFile = file && 't' in file ? file.t : null;
  const all = fromFile ? [fromOption, fromFile] : [fromOption];

  for (const w of all.flatMap((t) => t.warnings)) {
    warnOnce(`policy: ${w}`);
  }

  return {
    deny: [...new Set(all.flatMap((t) => t.deny))],
    outOfBand: all.map((t) => t.outOfBand).reduce(stricter),
    broken: file && 'broken' in file ? file.broken : null,
  };
}
