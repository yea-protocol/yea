/**
 * The check on the pinned principal key (SPEC-approval §2): neither its file, any symlink on the
 * way to it, nor any directory above one of them may be changeable by the server's OS user. The
 * opposite of key-file.ts, whose files only this user may see. Node only; exported from
 * `@yea-protocol/sdk/node`.
 */
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  readlinkSync,
  type Stats,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { isPublicKey } from './grants.js';
import { canCheckOwners, openNoFollow, readCapped, uid } from './key-file.js';

/** Every path met on the way to a file, symlinks included, and the real path it ends at. */
interface LinkChain {
  visited: string[];
  real: string;
}

/** As the kernel does: more symlinks than this on one path is a loop. */
const MAX_HOPS = 40;

/** Split `path` into its root and the parts after it. */
function rootAndParts(path: string): { root: string; parts: string[] } {
  const { root } = parse(path);

  return { root, parts: path.slice(root.length).split(sep) };
}

/**
 * Resolve `path` one symlink at a time, as the kernel would, recording every path visited.
 * Each step starts from a directory already resolved, so a link's target is read relative to
 * where the link really is. Throws if a part is missing or the links loop.
 */
function resolveLinks(path: string): LinkChain {
  const visited: string[] = [];
  let { root: cur, parts: rest } = rootAndParts(path);
  let hops = 0;

  for (let part = rest.shift(); part !== undefined; part = rest.shift()) {
    if (part === '' || part === '.' || part === '..') {
      cur = part === '..' ? dirname(cur) : cur;

      continue;
    }

    const next = join(cur, part);

    visited.push(next);

    if (!lstatSync(next).isSymbolicLink()) {
      cur = next;

      continue;
    }

    if (++hops > MAX_HOPS) {
      throw new Error(`${path}: too many levels of symbolic links`);
    }

    const target = readlinkSync(next);
    const t = rootAndParts(target);

    cur = isAbsolute(target) ? t.root : cur;
    rest = [...t.parts, ...rest];
  }

  return { visited, real: cur };
}

/** Each path in the chain and every directory above it, once. */
function everyPathAbove({ visited, real }: LinkChain): string[] {
  const all = new Set<string>();

  for (let p of [...visited, real]) {
    for (;;) {
      all.add(p);

      const up = dirname(p);

      if (up === p) {
        break;
      }

      p = up;
    }
  }

  return [...all];
}

const reachableBy = (p: string) =>
  `${p} can be changed by this user, so the agent could replace the principal key`;

/**
 * Why this OS user could change `p`, or null: it owns it, or (unless `p` is a symlink, whose
 * own mode means nothing) can write it.
 */
function reachable(p: string): string | null {
  let st: Stats;

  try {
    st = lstatSync(p);
  } catch {
    return `${p} can't be read`;
  }

  if (st.uid === uid()) {
    return reachableBy(p);
  }

  if (st.isSymbolicLink()) {
    return null; // its directory and its target are checked
  }

  try {
    accessSync(p, constants.W_OK);

    return reachableBy(p);
  } catch {
    return null;
  }
}

/** The key file's real path once the whole chain to it is out of this user's reach, or why not. */
function checkChain(path: string): { real: string } | { why: string } {
  if (!canCheckOwners()) {
    return {
      why: "can't check who owns the principal key file on this platform",
    };
  }

  if (uid() === 0) {
    return {
      why: 'refusing to trust a principal key file while running as root: run the server as its own user',
    };
  }

  let chain: LinkChain;

  try {
    chain = resolveLinks(resolve(path));

    if (!statSync(chain.real).isFile()) {
      return { why: `${path} is not a regular file` };
    }
  } catch {
    return { why: `${path} can't be read` };
  }

  for (const p of everyPathAbove(chain)) {
    const why = reachable(p);

    if (why) {
      return { why };
    }
  }

  return { real: chain.real };
}

/**
 * Why the principal key file can't be trusted, or null. Neither the file, any symlink on the way
 * to it, nor any directory above one of them may be owned or writable by the server's OS user,
 * or the agent could swap the key.
 */
export function checkKeyFile(path: string): string | null {
  const out = checkChain(path);

  return 'why' in out ? out.why : null;
}

/** World-writable, or group-writable by a group this process is in. */
function writableByUs(st: Stats): boolean {
  const groups = [process.getegid?.(), ...(process.getgroups?.() ?? [])];

  return (
    (st.mode & 0o002) !== 0 ||
    ((st.mode & 0o020) !== 0 && groups.includes(st.gid))
  );
}

/**
 * The text of the checked key file at `real`, opened once without following a symlink or
 * waiting on a FIFO, and checked again on that descriptor: a regular file this user still
 * can't change. Throws the reason otherwise.
 */
function readChecked(real: string): string {
  const fd = openNoFollow(real, 'the principal key');

  try {
    const st = fstatSync(fd);

    if (!st.isFile()) {
      throw new Error(`${real} is not a regular file`);
    }

    if (st.uid === uid() || writableByUs(st)) {
      throw new Error(`${real} changed while it was being read`);
    }

    const text = readCapped(fd);

    if (text === null) {
      throw new Error(`${real} is too big for a key file`);
    }

    return text;
  } finally {
    closeSync(fd);
  }
}

/** The pinned principal public key from `YEA_PRINCIPAL_PUB`, or why there isn't a usable one. */
export function readPinnedKey(
  path = process.env.YEA_PRINCIPAL_PUB,
): { key: string } | { why: string } {
  if (!path) {
    return { why: 'YEA_PRINCIPAL_PUB is not set' };
  }

  const checked = checkChain(path);

  if ('why' in checked) {
    return checked;
  }

  let key: string;

  try {
    key = readChecked(checked.real).trim();
  } catch (e) {
    return { why: (e as Error).message };
  }

  return isPublicKey(key)
    ? { key }
    : { why: `${path} does not hold an ed25519 public key` };
}
