/**
 * Pending files (docs/framework/SPEC-approval.md §6, Short ids): each consent code an issuer
 * hands out, written under a short id where `yea approve <id>` on the same account finds it.
 * A file is the code on one line and nothing else, so `yea approve` trusts nothing in it that a
 * pasted code isn't.
 */
import { closeSync, fstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { decodeConsentCode } from '../consent.js';
import { openNoFollow, readCapped } from '../key-file.js';
import type { ConsentRequest } from '../types.js';
import { errno } from '../util.js';
import { writeAtomic } from './files.js';

/** What a pending code says: the consent request it carries, and the agent it names, if any. */
export type PendingConsent = ConsentRequest & { agent?: unknown };

/** A pending code as read back: its id, the code, and what the code says. */
export interface PendingCode {
  id: string;
  code: string;
  consent: PendingConsent;
}

/** The ids `yea approve <id>` accepts, matched whole: never a path, and no prefix search. */
export const PENDING_ID = /^[A-Za-z0-9_-]{8,32}$/;

/** Lowercase base32: 32 letters and digits, so a random byte's low 5 bits pick one evenly. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const ID_LENGTH = 10;

/** A new id: 10 random characters of lowercase base32, which never start with `-`. */
export function newPendingId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(ID_LENGTH));

  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
}

/** What a pending file holds for `code`: the code verbatim, on one line. */
export const pendingFile = (code: string) => `${code}\n`;

/**
 * The text of the pending file at `path`, or null if there is none. It's opened without
 * following a symlink, and only a regular file of at most 64 KiB is read.
 */
function readPendingFile(path: string): string | null {
  let fd: number;

  try {
    fd = openNoFollow(path, 'pending file');
  } catch (e) {
    if (errno((e as Error).cause) === 'ENOENT') {
      return null;
    }

    throw e;
  }

  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`refusing pending file: ${path} is not a regular file`);
    }

    const text = readCapped(fd);

    if (text === null) {
      throw new Error(`refusing pending file: ${path} is larger than 64 KiB`);
    }

    return text;
  } finally {
    closeSync(fd);
  }
}

/** The code in a pending file's text: its first line. */
const firstLine = (text: string) => text.split('\n', 1)[0].trim();

/** The pending codes in one directory: `<store>/pending` for a server, `<home>/pending` for the bridge. */
export class PendingCodes {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Write `code` and return its id. A file already there for the code's service and proposal is
   * rewritten under its id, so an id handed out earlier still works; other files for the pair,
   * and every file whose code has expired, are removed.
   */
  put(code: string, now: number): string {
    const c = decodeConsentCode(code);
    const all = this.entries();
    const same = all.filter((e) => samePair(e.consent, c));
    const kept = same[0]?.id ?? this.freshId();

    for (const e of all) {
      if (e.id !== kept && (same.includes(e) || e.consent.expires <= now)) {
        this.remove(e.id);
      }
    }

    writeAtomic(join(this.dir, kept), pendingFile(code));

    return kept;
  }

  /** Remove the files for one service and proposal: its plan ran, or its entry went. */
  drop(service: string, proposal: string) {
    for (const e of this.entries()) {
      if (samePair(e.consent, { service, proposal })) {
        this.remove(e.id);
      }
    }
  }

  /** Remove every file `mine` says this issuer wrote (the bridge, at start-up). */
  clear(mine: (c: PendingConsent) => boolean) {
    for (const e of this.entries()) {
      if (mine(e.consent)) {
        this.remove(e.id);
      }
    }
  }

  /** The codes that haven't expired, soonest to expire first. */
  list(now: number): PendingCode[] {
    return this.entries()
      .filter((e) => e.consent.expires > now)
      .sort((a, b) => a.consent.expires - b.consent.expires);
  }

  /**
   * The code under `id`, or null if there's no such file. Throws for an id outside
   * `PENDING_ID`, a symlink, anything but a regular file, and a file over 64 KiB.
   */
  read(id: string): string | null {
    if (!PENDING_ID.test(id)) {
      throw new Error('not a pending id');
    }

    const text = readPendingFile(join(this.dir, id));

    return text === null ? null : firstLine(text);
  }

  /** Every file here that reads as a code; anything else is left alone. */
  private entries(): PendingCode[] {
    return this.ids().flatMap((id) => {
      try {
        const code = this.read(id);

        return code ? [{ id, code, consent: decodeConsentCode(code) }] : [];
      } catch {
        return [];
      }
    });
  }

  private ids(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => PENDING_ID.test(f));
    } catch (e) {
      if (errno(e) === 'ENOENT') {
        return [];
      }

      throw e;
    }
  }

  private freshId(): string {
    const taken = new Set(this.ids());
    let id = newPendingId();

    while (taken.has(id)) {
      id = newPendingId();
    }

    return id;
  }

  private remove(id: string) {
    rmSync(join(this.dir, id), { force: true });
  }
}

const samePair = (
  a: Pick<ConsentRequest, 'service' | 'proposal'>,
  b: Pick<ConsentRequest, 'service' | 'proposal'>,
) => a.service === b.service && a.proposal === b.proposal;
