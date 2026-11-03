/** Services for your AI tools: add, remove, services, install (setup) and uninstall. */
import type { KeyPair } from '../crypto.js';
import { type Caveat, inspectGrant, issueGrant } from '../grants.js';
import {
  agentKey,
  home,
  loadGrants,
  principalKey,
  saveGrant,
} from '../home.js';
import { untrustedLens } from '../lens.js';
import {
  addService,
  CLIENTS,
  detectedClients,
  listServices,
  removeService,
} from '../setup.js';
import { printable } from '../text.js';
import { unixNow } from '../util.js';
import {
  command,
  type Flag,
  type Flags,
  positional,
  UsageError,
  type Values,
} from './command.js';
import { client, confirm, die, installScope, LOCAL_FLAG } from './shared.js';

/** The AI tools to set up or remove. */
const TARGET_FLAG = {
  type: 'string',
  value: 'tools',
  choices: Object.keys(CLIENTS),
  help: `only these, comma-separated: ${Object.keys(CLIENTS).join(', ')}`,
} as const satisfies Flag;

/**
 * The AI tools `--target` names, or `fallback` without it. An unknown one is a usage error, so
 * nothing is done for a typo.
 */
function targets(o: { target?: string }, fallback: string[]): string[] {
  const names = o.target ? o.target.split(',').map((t) => t.trim()) : fallback;
  const unknown = names.find((n) => !Object.hasOwn(CLIENTS, n));

  if (unknown !== undefined) {
    throw new UsageError(
      `unknown target ${unknown}`,
      `targets: ${Object.keys(CLIENTS).join(', ')}`,
    );
  }

  return names;
}

export const cmdAdd = command({
  summary:
    'Check a service answers, and add it for your AI tools (restart them to pick it up).',
  usage: 'add <url>',
  flags: {},
  example: 'yea add yea://127.0.0.1:7447',
  run: add,
});

async function add(rest: string[]) {
  const url = positional(rest, 0, 'url');
  const c = await client(url, {});
  const b = await c.hello(400);

  c.close();

  if (b.kind !== 'BRIEF') {
    return die(untrustedLens(b));
  }

  addService(url);
  console.log(
    printable(
      `✓ added ${b.service.name} (${b.service.id}) · ${b.capabilities.length} capabilities`,
    ),
  );
  console.log('  restart your AI tool to pick it up');
}

export const cmdRemove = command({
  summary: 'Remove a service from your AI tools.',
  usage: 'remove <url>',
  flags: {},
  example: 'yea remove yea://127.0.0.1:7447',
  run: remove,
});

async function remove(rest: string[]) {
  const url = positional(rest, 0, 'url');

  removeService(url);
  console.log(`✓ removed ${url}`);
}

export const cmdServices = command({
  summary: 'List the services added for your AI tools.',
  usage: 'services',
  flags: {},
  example: 'yea services',
  run: services,
});

async function services() {
  const s = listServices();

  console.log(s.length ? s.join('\n') : 'no services yet: yea add <url>');
}

const INSTALL_FLAGS = {
  target: TARGET_FLAG,
  local: LOCAL_FLAG,
  'with-principal': {
    type: 'boolean',
    help: 'also create your principal (approval) key here, to try things quickly',
  },
  yes: {
    type: 'boolean',
    short: 'y',
    help: "don't ask; without --with-principal, no principal key is created",
  },
} as const satisfies Flags;

export const cmdInstall = command({
  summary:
    'Set YEA up for your AI tools: an agent key, a safe default policy, the MCP bridge and agent instructions. Detects your tools (alias: setup).',
  usage: 'install [flags]',
  flags: INSTALL_FLAGS,
  example: 'yea install --target claude-code,cursor',
  run: (_args, o) => install(o),
});

async function install(o: Values<typeof INSTALL_FLAGS>) {
  const scope = installScope(o);
  const names = targets(o, detectedClients());

  const a = (await agentKey()) ?? (await agentKey(true));

  console.log(`agent key   ${a.public} (${home()})`);

  const p = await installPrincipal(a, o);

  if (p && !loadGrants('grants').length) {
    await installDefaultPolicy(p, a);
  }

  if (!names.length) {
    console.log(
      `\nno AI tools detected. Pick some: yea install --target ${Object.keys(CLIENTS).join(',')}`,
    );
  }

  for (const n of names) {
    try {
      for (const line of CLIENTS[n].install(scope)) {
        console.log(`✓ ${CLIENTS[n].name}: ${line}`);
      }
    } catch (e) {
      console.log(`✗ ${CLIENTS[n].name}: ${(e as Error).message}`);
    }
  }

  const s = listServices();

  console.log(
    s.length
      ? `\nservices    ${s.join(', ')}`
      : '\nnext: add a service with `yea add <url>`, or try the examples: `yea examples`, then `yea add yea://127.0.0.1:7447`',
  );
  console.log(
    'restart your AI tool, then ask it to do something. Check anything with: yea doctor',
  );
}

/**
 * The principal (approval) key should live where agents can't read it. Only create it here
 * when asked: --with-principal, or a yes at the interactive prompt.
 */
async function installPrincipal(
  a: KeyPair,
  o: { yes?: boolean; 'with-principal'?: boolean },
): Promise<KeyPair | null> {
  const existing = await principalKey();

  if (existing) {
    console.log(`principal   ${existing.public}`);

    return existing;
  }

  let create = !!o['with-principal'];

  if (!create && process.stdin.isTTY && !o.yes) {
    create = await confirm(
      'Create your approval (principal) key on this machine too? Handy for trying YEA, but an agent with shell access could read it. [y/N] › ',
    );
  }

  if (!create) {
    console.log(
      `principal   not on this machine (recommended). On the device that holds it, run:\n              yea grant --to ${a.public} --risk low --each spend=25.00USD --total spend=100.00USD --exp 30d\n            and save the token here with: yea grant-import <token>   (or re-run with --with-principal to try things quickly)`,
    );

    return null;
  }

  const p = await principalKey(true);

  console.log(
    `principal   ${p.public} (on this machine: fine for trying things; see SECURITY.md for real use)`,
  );

  return p;
}

/** Grant the agent a safe default policy: low risk, ≤ 25 USD each, ≤ 100 USD total, 30 days. */
async function installDefaultPolicy(p: KeyPair, a: KeyPair) {
  const caveats: Caveat[] = [
    { risk: 'low' },
    { each: { of: 'spend', max: 2500, scale: 2, unit: 'USD' } },
    { total: { of: 'spend', max: 10000, scale: 2, unit: 'USD' } },
    { exp: unixNow() + 30 * 86400 },
  ];
  const token = await issueGrant({ principal: p, to: a.public, caveats });

  saveGrant(token, 'grants', (await inspectGrant(token)).id.slice(0, 16));
  console.log(
    'policy      low-risk actions, ≤ 25.00 USD each, ≤ 100.00 USD total, 30 days. Anything else asks you. (change: yea grant …)',
  );
}

const UNINSTALL_FLAGS = {
  target: TARGET_FLAG,
  local: LOCAL_FLAG,
} as const satisfies Flags;

export const cmdUninstall = command({
  summary: 'Remove YEA from your AI tools. Keys and grants are left in place.',
  usage: 'uninstall [flags]',
  flags: UNINSTALL_FLAGS,
  example: 'yea uninstall --target cursor',
  run: (_args, o) => uninstall(o),
});

async function uninstall(o: Values<typeof UNINSTALL_FLAGS>) {
  const scope = installScope(o);
  const names = targets(o, Object.keys(CLIENTS));
  let n = 0;

  for (const name of names) {
    try {
      for (const line of CLIENTS[name]?.uninstall(scope) ?? []) {
        console.log(`✓ ${CLIENTS[name].name}: ${line}`);
        n++;
      }
    } catch (e) {
      console.log(`✗ ${CLIENTS[name]?.name ?? name}: ${(e as Error).message}`);
    }
  }

  console.log(
    n
      ? `done. Keys and grants in ${home()} were left in place (delete that folder to remove them).`
      : 'nothing to remove.',
  );
}
