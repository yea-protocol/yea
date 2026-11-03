/** Services for your AI tools: add, remove, services, install (setup) and uninstall. */
import { agentKey, home } from '../home.js';
import { untrustedLens } from '../lens.js';
import {
  addService,
  type BridgeCommand,
  bridgeFor,
  CLIENTS,
  describeBridge,
  detectedClients,
  isPortableBridge,
  listServices,
  removeService,
  runningBridge,
  type Scope,
  type Target,
} from '../setup.js';
import { printable } from '../text.js';
import {
  command,
  type Flag,
  type Flags,
  positional,
  UsageError,
  type Values,
} from './command.js';
import { installPrincipal } from './install/principal.js';
import { client, die, installScope, LOCAL_FLAG, self } from './shared.js';

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

  console.log(
    s.length ? s.join('\n') : `no services yet: ${self('add <url>')}`,
  );
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
  // Before anything is written: a checkout that isn't built can't start the bridge.
  const running = runningBridge();

  const a = (await agentKey()) ?? (await agentKey(true));

  console.log(`agent key   ${a.public} (${home()})`);

  await installPrincipal(a, o);
  console.log(
    `bridge      ${describeBridge(running.bridge)}${running.checkout ? ' (this checkout)' : ''}`,
  );

  if (!names.length) {
    console.log(
      `\nno AI tools detected. Pick some: ${self(`install --target ${Object.keys(CLIENTS).join(',')}`)}`,
    );
  }

  for (const n of names) {
    installTarget(CLIENTS[n], scope, running.bridge);
  }

  const s = listServices();

  console.log(
    s.length
      ? `\nservices    ${s.join(', ')}`
      : `\nnext: add a service with \`${self('add <url>')}\`, or try the examples: \`${self('examples')}\`, then \`${self('add yea://127.0.0.1:7447')}\``,
  );
  console.log(
    `restart your AI tool, then ask it to do something. Check anything with: ${self('doctor')}`,
  );
}

/** Register the bridge with `t`: the running command, or the portable one in a project file. */
function installTarget(t: Target, s: Scope, running: BridgeCommand) {
  try {
    const placement = t.placement(s);
    const bridge = bridgeFor(placement, running);

    for (const line of t.install(s, bridge)) {
      console.log(`✓ ${t.name}: ${line}`);
    }

    // On Windows, the running bridge is the portable one when yea came from npm.
    if (placement.project && !isPortableBridge(running)) {
      console.log(
        `  note: a project file, which others may share, so it gets the portable ${describeBridge(bridge)}`,
      );
    }
  } catch (e) {
    console.log(`✗ ${t.name}: ${(e as Error).message}`);
  }
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
