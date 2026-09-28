/**
 * What a job server trusts on each call (SPEC-mcp-ts `yea()`, SPEC-approval §2): the pinned
 * principal key, the signed policy grant, and the unsigned tightening. The policy and tightening
 * are read on every call, so a new grant applies without a restart; the principal is read once.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  atLeast,
  isPublicKey,
  isRisk,
  type Risk,
  readTightening,
  type Tightening,
} from '@yea-protocol/sdk';
import { home, readPinnedKey } from '@yea-protocol/sdk/node';
import { errno, errorMessage, warnOnce } from './util.js';

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
