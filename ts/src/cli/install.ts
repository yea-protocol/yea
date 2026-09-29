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
import { client, confirm, die, installScope, type Options } from './shared.js';

export async function cmdAdd(rest: string[], o: Options) {
  const url = rest[0] ?? die('usage: yea add <url>');
  const c = await client(url, o);
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

export async function cmdRemove(rest: string[]) {
  removeService(rest[0] ?? die('usage: yea remove <url>'));
  console.log(`✓ removed ${rest[0]}`);
}

export async function cmdServices() {
  const s = listServices();

  console.log(s.length ? s.join('\n') : 'no services yet: yea add <url>');
}

export async function cmdInstall(_rest: string[], o: Options) {
  const scope = installScope(o);
  const names = o.target
    ? o.target.split(',').map((t) => t.trim())
    : detectedClients();

  for (const n of names) {
    if (!CLIENTS[n]) {
      die(`unknown target ${n}; one of: ${Object.keys(CLIENTS).join(', ')}`);
    }
  }

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
  o: Options,
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

export async function cmdUninstall(_rest: string[], o: Options) {
  const scope = installScope(o);
  const names = o.target
    ? o.target.split(',').map((t) => t.trim())
    : Object.keys(CLIENTS);
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
