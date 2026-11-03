/** Identity commands: keys, service ids and grants (init, whoami, service-id, grant, …). */
import { dirname } from 'node:path';
import { keyPair } from '../crypto.js';
import { delegateGrant, inspectGrant, issueGrant } from '../grants.js';
import { agentKey, home, principalKey, saveGrant } from '../home.js';
import {
  checkServerKeyDir,
  readServerSeed,
  SERVER_NAME,
  serverKeyPath,
} from '../key-file.js';
import { fmtTime, lean } from '../lens.js';
import { errno, isObject } from '../util.js';
import { CAVEAT_FLAGS, caveats } from './caveats.js';
import { command, type Flags, type Values } from './command.js';
import { die } from './shared.js';

export const cmdInit = command({
  summary:
    'Create your principal (approval) key and an agent key in ~/.yea (or $YEA_HOME).',
  usage: 'init',
  flags: {},
  example: 'yea init',
  run: init,
});

async function init() {
  const p = await principalKey(true),
    a = await agentKey(true);

  console.log(
    `principal ${p.public}\nagent     ${a.public}\n\nnext: yea grant --exp 24h --total spend=100.00USD --risk low`,
  );
}

export const cmdWhoami = command({
  summary: 'Show your public keys.',
  usage: 'whoami',
  flags: {},
  example: 'yea whoami',
  run: whoami,
});

async function whoami() {
  const p = await principalKey(),
    a = await agentKey();

  console.log(
    `principal ${p?.public ?? '(none — run yea init)'}\nagent     ${a?.public ?? '(none)'}`,
  );
}

export const cmdServiceId = command({
  summary:
    "Print an MCP server's service id, for yea grant --to (a server with a custom key path logs it at start-up).",
  usage: 'service-id <name>',
  flags: {},
  example: 'yea service-id files',
  run: serviceId,
});

/**
 * The service id of an MCP server built with `@yea-protocol/mcp` or `yea-mcp`: the public key
 * of its seed in `~/.yea/server/<name>.key`, which `yea grant --to` needs.
 */
async function serviceId(rest: string[]) {
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

const GRANT_FLAGS = {
  ...CAVEAT_FLAGS,
  to: {
    type: 'string',
    value: 'key',
    help: "the holder, if not this machine's agent key (then it isn't saved)",
  },
} as const satisfies Flags;

export const cmdGrant = command({
  summary:
    'Sign a grant from your principal key to an agent: your policy. Saved and used automatically.',
  usage: 'grant [flags]',
  flags: GRANT_FLAGS,
  example: 'yea grant --exp 24h --total spend=100.00USD --risk low',
  run: (_args, o) => grant(o),
});

async function grant(o: Values<typeof GRANT_FLAGS>) {
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

export const cmdGrantImport = command({
  summary:
    "Save a grant issued to this machine's agent key on another device (the principal key stays there).",
  usage: 'grant-import <token>',
  flags: {},
  example: 'yea grant-import pg1.…',
  run: grantImport,
});

async function grantImport(rest: string[]) {
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

export const cmdDelegate = command({
  summary: 'Narrow a grant you hold and pass it to a sub-agent.',
  usage: 'delegate <token> --to <key> [flags]',
  flags: {
    ...CAVEAT_FLAGS,
    to: {
      type: 'string',
      value: 'key',
      help: "the sub-agent's key (required)",
    },
  },
  example: 'yea delegate pg1.… --to ed25519:… --verbs ASK,INTENT',
  run: delegate,
});

async function delegate(
  rest: string[],
  o: Values<typeof CAVEAT_FLAGS> & { to?: string },
) {
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

export const cmdInspect = command({
  summary: 'Decode a grant chain: who issued it, to whom, and its caveats.',
  usage: 'inspect <token>',
  flags: {},
  example: 'yea inspect pg1.…',
  run: inspect,
});

async function inspect(rest: string[]) {
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
