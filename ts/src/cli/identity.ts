/** Identity commands: keys, service ids and grants (init, whoami, service-id, grant, …). */
import { dirname } from 'node:path';
import { keyPair } from '../crypto.js';
import {
  type Caveat,
  delegateGrant,
  inspectGrant,
  issueGrant,
} from '../grants.js';
import { agentKey, home, principalKey, saveGrant } from '../home.js';
import {
  checkServerKeyDir,
  readServerSeed,
  SERVER_NAME,
  serverKeyPath,
} from '../key-file.js';
import { fmtTime, lean } from '../lens.js';
import { isRisk } from '../risk.js';
import type { Verb } from '../types.js';
import { isLimit, type Limit } from '../uses.js';
import { errno, isObject, unixNow } from '../util.js';
import { die, type Options } from './shared.js';

function duration(s: string): number {
  const m =
    /^(\d+)([smhd])$/.exec(s) ??
    die(`bad duration ${s} (use e.g. 30m, 24h, 7d)`);

  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's'];
}

/** `spend=25.00USD` or `emails=20` → a limit on that measure (SPEC §6.3). */
function limit(s: string): Limit {
  const m =
    /^([a-z][a-z0-9_.-]*)=(\d+)(?:\.(\d+))?\s*([A-Za-z%][A-Za-z0-9_./%-]*)?$/.exec(
      s,
    ) ?? die(`bad limit ${s} (use e.g. spend=25.00USD or emails=20)`);
  const decimals = m[3] ?? '';
  const l = {
    of: m[1],
    max: Number(m[2] + decimals),
    ...(decimals ? { scale: decimals.length } : {}),
    ...(m[4] ? { unit: m[4] } : {}),
  };

  return isLimit(l) ? l : die(`bad limit ${s} (amount or unit out of range)`);
}

function caveats(o: Options): Caveat[] {
  const c: Caveat[] = [];

  if (o.svc) {
    c.push({ svc: o.svc });
  }

  if (o.can) {
    c.push({ can: o.can });
  }

  if (o.verbs) {
    c.push({
      verbs: o.verbs.split(',').map((v) => v.trim().toUpperCase()) as Verb[],
    });
  }

  if (o.exp) {
    c.push({ exp: unixNow() + duration(o.exp) });
  }

  for (const l of o.each ?? []) {
    c.push({ each: limit(l) });
  }

  for (const l of o.total ?? []) {
    c.push({ total: limit(l) });
  }

  if (o.risk !== undefined) {
    c.push({
      risk: isRisk(o.risk)
        ? o.risk
        : die(`bad risk ${o.risk} (low|medium|high)`),
    });
  }

  return c;
}

export async function cmdInit() {
  const p = await principalKey(true),
    a = await agentKey(true);

  console.log(
    `principal ${p.public}\nagent     ${a.public}\n\nnext: yea grant --exp 24h --total spend=100.00USD --risk low`,
  );
}

export async function cmdWhoami() {
  const p = await principalKey(),
    a = await agentKey();

  console.log(
    `principal ${p?.public ?? '(none — run yea init)'}\nagent     ${a?.public ?? '(none)'}`,
  );
}

/**
 * The service id of an MCP server built with `@yea-protocol/mcp` or `yea-mcp`: the public key
 * of its seed in `~/.yea/server/<name>.key`, which `yea grant --to` needs.
 */
export async function cmdServiceId(rest: string[]) {
  const name = rest[0] ?? die('usage: yea service-id <name>');

  if (!SERVER_NAME.test(name)) {
    die(
      `bad server name ${JSON.stringify(name)}: it matches [a-z0-9._-]{1,64}`,
    );
  }

  console.log((await keyPair(serverSeed(serverKeyPath(name)))).public);
}

/**
 * The seed in a server key file, held to the rules the server itself applies: a key directory
 * only this user can change, and a key file that is not a symlink, is this user's and is
 * private (0600 or 0400). So the id printed is the one the server uses.
 */
function serverSeed(path: string): string {
  try {
    return checkedServerSeed(path);
  } catch (e) {
    return missing(e)
      ? die(`no server key at ${path}: start the server once to create it`)
      : die((e as Error).message);
  }
}

/** The key directory's check, then the key file's; throws why either is refused. */
function checkedServerSeed(path: string): string {
  const why = checkServerKeyDir(dirname(path));

  if (why) {
    throw new Error(`refusing the server key: ${why}`);
  }

  return readServerSeed(path);
}

/** Whether `e`, or the error it wraps, is ENOENT. */
function missing(e: unknown): boolean {
  return errno(e) === 'ENOENT' || (isObject(e) && errno(e.cause) === 'ENOENT');
}

export async function cmdGrant(_rest: string[], o: Options) {
  // Bad caveat flags are refused before any key is read.
  const cav = caveats(o);
  const p = (await principalKey()) ?? die('no principal key — run yea init');
  const to = o.to ?? (await agentKey())?.public ?? die('no agent key');
  const token = await issueGrant({ principal: p, to, caveats: cav });
  const info = await inspectGrant(token);

  if (!o.to) {
    saveGrant(token, 'grants', info.id.slice(0, 16));
  }

  console.log(token);
  console.error(
    `\ngrant ${info.id.slice(0, 16)} → ${to}\n${lean({ caveats: info.blocks[0].caveats })}${o.to ? '' : `\nsaved to ${home()}/grants`}`,
  );
}

export async function cmdGrantImport(rest: string[]) {
  const token = rest[0] ?? die('usage: yea grant-import <pg1.… token>');
  const info = await inspectGrant(token);
  const a = await agentKey();

  if (!a || info.holder !== a.public) {
    die(
      `this grant is for ${info.holder}, not this machine's agent key ${a?.public ?? '(none: run yea install)'}`,
    );
  }

  saveGrant(token, 'grants', info.id.slice(0, 16));
  console.log(`✓ imported grant ${info.id.slice(0, 16)} from ${info.iss}`);
}

export async function cmdDelegate(rest: string[], o: Options) {
  const a = (await agentKey()) ?? die('no agent key');

  console.log(
    await delegateGrant(
      rest[0] ?? die('usage: yea delegate <token> --to <key>'),
      {
        holder: a,
        to: o.to ?? die('--to required'),
        caveats: caveats(o),
      },
    ),
  );
}

export async function cmdInspect(rest: string[]) {
  const info = await inspectGrant(rest[0] ?? die('usage: yea inspect <token>'));

  console.log(
    lean({
      id: info.id,
      principal: info.iss,
      holder: info.holder,
      chain: info.blocks.map((b) => ({
        to: b.sub,
        issued: fmtTime(b.iat),
        caveats: b.caveats.map((c) => JSON.stringify(c)),
      })),
    }),
  );
}
