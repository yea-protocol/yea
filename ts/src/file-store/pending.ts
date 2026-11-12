/**
 * Pending files (docs/framework/SPEC-approval.md §6, Short ids): each consent code an issuer
 * hands out, written under a short id where `yea approve <id>` on the same account finds it.
 * A file is the code on its first line, so `yea approve` trusts nothing in it that a pasted
 * code isn't. The bridge adds a second line naming the process that wrote it, which only its
 * start-up cleanup and the listing read.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../canonical.js';
import { consentExpiry, decodeConsentCode } from '../consent.js';
import type { ConsentRequest } from '../types.js';
import { errno } from '../util.js';
import { NotRegularFile, readRegular, writeAtomic } from './files.js';

/**
 * What a pending code says: the consent request it carries, and the agent it names, if any. Its
 * `expires` is the consent's (`consentExpiry`), so a code is listed, and removed, with its proposal.
 */
export type PendingConsent = ConsentRequest & { agent?: unknown };

/** The process that wrote a pending file: its pid, in this home's one-machine account. */
export interface PendingIssuer {
  pid: number;
}

/** A pending code as read back: its id, the code, what the code says, and who wrote it. */
export interface PendingCode {
  id: string;
  code: string;
  consent: PendingConsent;
  /** Null for a file without the second line: a server's, which names no process. */
  issuer: PendingIssuer | null;
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

/**
 * What a pending file holds for `code`: the code verbatim, on one line, then, if given, the
 * process that wrote it as canonical JSON on a second.
 */
export const pendingFile = (code: string, issuer?: PendingIssuer) =>
  issuer ? `${code}\n${canonical({ pid: issuer.pid })}\n` : `${code}\n`;

/**
 * The text of the pending file at `path`, or null if there is none, read as `readRegular` reads
 * one: a symlink, anything but a regular file, and a file over 64 KiB are refused.
 */
function readPendingFile(path: string): string | null {
  try {
    return readRegular(path);
  } catch (e) {
    throw new Error(`refusing pending file: ${refusedWhy(path, e)}`, {
      cause: e,
    });
  }
}

/** Why `readRegular` refused a pending file, as the other private files say it. */
function refusedWhy(path: string, e: unknown): string {
  if (e instanceof NotRegularFile) {
    return `${path} is ${e.tooBig ? 'larger than 64 KiB' : 'not a regular file'}`;
  }

  if (errno(e) === 'ELOOP') {
    return `${path} is a symlink`;
  }

  return e instanceof Error ? e.message : String(e);
}

/** The code in a pending file's text: its first line. */
const firstLine = (text: string) => text.split('\n', 1)[0].trim();

/** The process a pending file's second line names, or null if it names none it can read. */
function issuerOf(text: string): PendingIssuer | null {
  try {
    const v = JSON.parse(text.split('\n')[1] ?? '') as Partial<PendingIssuer>;

    // Only a real pid: 0 and negative ones name process groups, not a process.
    return typeof v.pid === 'number' && Number.isSafeInteger(v.pid) && v.pid > 0
      ? { pid: v.pid }
      : null;
  } catch {
    return null;
  }
}

/** Whether process `pid` is still running (EPERM: it is, as another user). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (e) {
    return errno(e) === 'EPERM';
  }
}

/**
 * Whether a pending file names a process that has ended: a bridge no one runs now, so no one
 * holds its proposal and its code can never commit. A home is one account's on one machine, so
 * its pids are this machine's. A server's file names no process.
 */
export const issuerEnded = (e: PendingCode) =>
  e.issuer !== null && !running(e.issuer.pid);

/** The pending codes in one directory: `<store>/pending` for a server, `<home>/pending` for the bridge. */
export class PendingCodes {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Write `code` and return its id. A file already there for the code's service and proposal is
   * rewritten under its id, so an id handed out earlier still works; other files for the pair,
   * and every file whose consent has expired, are removed.
   */
  put(code: string, now: number, issuer?: PendingIssuer): string {
    const c = decodeConsentCode(code);
    const all = this.entries();
    const same = all.filter((e) => samePair(e.consent, c));
    const kept = same[0]?.id ?? this.freshId();

    for (const e of all) {
      if (e.id !== kept && (same.includes(e) || e.consent.expires <= now)) {
        this.remove(e.id);
      }
    }

    writeAtomic(join(this.dir, kept), pendingFile(code, issuer));

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

  /** Remove every file `stale` picks (the bridge's, at start-up: those of bridges that ended). */
  clear(stale: (e: PendingCode) => boolean) {
    for (const e of this.entries()) {
      if (stale(e)) {
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
   * The code under `id`, or null if there's no file of exactly that name: it's matched against
   * the directory's names before anything is opened, so a case-insensitive disk can't hand back
   * another id's file. Throws for an id outside `PENDING_ID`, a symlink, anything but a regular
   * file, and a file over 64 KiB.
   */
  read(id: string): string | null {
    if (!PENDING_ID.test(id)) {
      throw new Error('not a pending id');
    }

    if (!this.ids().includes(id)) {
      return null;
    }

    const text = readPendingFile(join(this.dir, id));

    return text === null ? null : firstLine(text);
  }

  /** Every file here that reads as a code; anything else is left alone. */
  private entries(): PendingCode[] {
    return this.ids().flatMap((id) => {
      try {
        return this.entry(id) ?? [];
      } catch {
        return [];
      }
    });
  }

  /** The file under `id` as a pending code, or null if it's gone or empty; throws if it isn't one. */
  private entry(id: string): PendingCode | null {
    const text = readPendingFile(join(this.dir, id));
    const code = text === null ? '' : firstLine(text);

    if (text === null || !code) {
      return null;
    }

    const c = decodeConsentCode(code);

    return {
      id,
      code,
      consent: { ...c, expires: consentExpiry(c) },
      issuer: issuerOf(text),
    };
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
