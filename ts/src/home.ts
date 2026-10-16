/** Local identity store (~/.yea): the principal key, the agent key, grants and consents. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConsentStore } from './consent-round.js';
import { type KeyPair, keyPair } from './crypto.js';

let moved = false;

/** YEA was called Parley: carry an existing ~/.parley (keys, grants, services) over, once. */
function moveOldHome(to: string) {
  const from = join(homedir(), '.parley');

  moved = true;

  if (existsSync(to) || !existsSync(from)) {
    return;
  }

  renameSync(from, to);
  console.error(`moved ${from} to ${to} (Parley is now YEA)`);
}

export function home() {
  if (process.env.YEA_HOME) {
    return process.env.YEA_HOME;
  }

  const dir = join(homedir(), '.yea');

  if (!moved) {
    moveOldHome(dir);
  }

  return dir;
}

const p = (...s: string[]) => join(home(), ...s);

function ensure(dir: string) {
  for (const d of ['', 'grants', 'consents']) {
    mkdirSync(join(dir, d), { recursive: true, mode: 0o700 });
  }
}

/** The principal key may live elsewhere (another OS user, a mounted device): YEA_PRINCIPAL_HOME. */
const keyFile = (name: 'principal' | 'agent') =>
  name === 'principal' && process.env.YEA_PRINCIPAL_HOME
    ? join(process.env.YEA_PRINCIPAL_HOME, 'principal.key')
    : p(`${name}.key`);

async function loadKey(
  name: 'principal' | 'agent',
  create: true,
): Promise<KeyPair>;
async function loadKey(
  name: 'principal' | 'agent',
  create: boolean,
): Promise<KeyPair | null>;

async function loadKey(
  name: 'principal' | 'agent',
  create: boolean,
): Promise<KeyPair | null> {
  const f = keyFile(name);

  if (existsSync(f)) {
    return keyPair(readFileSync(f, 'utf8').trim());
  }

  if (!create) {
    return null;
  }

  ensure(home());
  mkdirSync(join(f, '..'), { recursive: true, mode: 0o700 });

  const kp = await keyPair();

  writeFileSync(f, `${kp.seed}\n`, { mode: 0o600 });

  return kp;
}

/** The principal (approval) key, or null if it isn't here; `create` makes one when missing. */
export function principalKey(create: true): Promise<KeyPair>;
export function principalKey(create?: boolean): Promise<KeyPair | null>;

export function principalKey(create = false) {
  return loadKey('principal', create);
}

/** The agent key, or null if it isn't here; `create` makes one when missing. */
export function agentKey(create: true): Promise<KeyPair>;
export function agentKey(create?: boolean): Promise<KeyPair | null>;

export function agentKey(create = false) {
  return loadKey('agent', create);
}

/** The file a grant or consent is saved in, named after `name` with unsafe characters replaced. */
const grantFile = (dir: string, kind: 'grants' | 'consents', name: string) =>
  join(dir, kind, `${name.replace(/[^A-Za-z0-9_-]/g, '_')}.pg`);

/** Save a grant or consent in the home `dir` (default: `home()`). */
export function saveGrant(
  token: string,
  kind: 'grants' | 'consents',
  name: string,
  dir = home(),
) {
  ensure(dir);
  writeFileSync(grantFile(dir, kind, name), `${token}\n`, { mode: 0o600 });
}

/** The consent saved for a proposal hash (by `yea approve` or the bridge), or null if none. */
export function loadConsent(hash: string, dir = home()): string | null {
  const f = grantFile(dir, 'consents', hash);

  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
}

/**
 * The agent's consents in the home `dir` (default: `home()`, so `~/.yea/consents`) as the consent
 * round's store: `yea approve` here writes it too.
 */
export const homeConsents = (dir = home()): ConsentStore => ({
  get: (hash) => loadConsent(hash, dir),
  put: (hash, token) => saveGrant(token, 'consents', hash, dir),
});

/** The grants or consents saved in the home `dir` (default: `home()`). */
export function loadGrants(
  kind: 'grants' | 'consents' = 'grants',
  dir = home(),
): string[] {
  const d = join(dir, kind);

  if (!existsSync(d)) {
    return [];
  }

  return readdirSync(d)
    .filter((f) => f.endsWith('.pg'))
    .map((f) => readFileSync(join(d, f), 'utf8').trim());
}
