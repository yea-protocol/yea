/**
 * `yea doctor`: check what an AI tool needs to start YEA (node, the agent key, its registration,
 * and that what it registered starts), then grants, services and the pinned principal key. Only
 * the first are ✗, and any ✗ makes it exit 1.
 */
import type { WithLens } from '../client.js';
import type { KeyPair } from '../crypto.js';
import { type GrantInfo, inspectGrant } from '../grants.js';
import { agentKey, home, loadGrants, principalKey } from '../home.js';
import { fmtTime, untrustedLens } from '../lens.js';
import { readPinnedKey } from '../pinned-key.js';
import { listServices, shellWord } from '../setup.js';
import type { Brief, ErrorReply } from '../types.js';
import { unixNow } from '../util.js';
import { command, type Flags, type Values } from './command.js';
import { checkRegistrations } from './doctor/registration.js';
import { Report } from './doctor/report.js';
import { client, installScope, LOCAL_FLAG, pinRecipe, self } from './shared.js';

const DOCTOR_FLAGS = { local: LOCAL_FLAG } as const satisfies Flags;

/** How long a service has to answer HELLO, connecting included: a stdio one starts first. */
const HELLO_TIMEOUT_MS = 5000;

/** Where a grant is issued, and so fixed: by the principal key, not here in the recommended setup. */
const WHERE_PRINCIPAL_IS = 'where your principal key is';

export const cmdDoctor = command({
  summary:
    'Check your node version, keys, grants and services, and start what each AI tool would start. Exits 1 if YEA would not start.',
  usage: 'doctor [flags]',
  flags: DOCTOR_FLAGS,
  example: 'yea doctor',
  run: (_args, o) => doctor(o),
});

async function doctor(o: Values<typeof DOCTOR_FLAGS>) {
  const r = new Report();
  const major = Number(process.versions.node.split('.')[0]);

  if (major >= 20) {
    r.ok(`node ${process.versions.node}`);
  } else {
    r.bad(`node ${process.versions.node}: YEA needs node ≥ 20 (nodejs.org)`);
  }

  const a = await agentKey();

  if (a) {
    r.ok(`agent key ${a.public.slice(0, 24)}…`);
  } else {
    r.bad(`no agent key: ${self('install')}`);
  }

  await reportPrincipal(r);
  await reportGrants(r, a);
  await checkServices(r);
  await checkRegistrations(r, installScope(o));

  if (r.failed) {
    process.exitCode = 1;
  }
}

/** Where the principal key is, and the pinned copy servers check approvals against, if set. */
async function reportPrincipal(r: Report) {
  const p = await principalKey();

  if (p) {
    r.warn(
      `principal key is readable here (${process.env.YEA_PRINCIPAL_HOME || home()}). Fine for trying things; for real use keep it away from agents (SECURITY.md)`,
    );
  } else {
    r.ok('principal key is not on this machine (recommended)');
  }

  if (!process.env.YEA_PRINCIPAL_PUB) {
    return;
  }

  const pinned = readPinnedKey();

  if ('key' in pinned) {
    r.ok(`pinned principal key ${pinned.key} (YEA_PRINCIPAL_PUB)`);
  } else {
    r.warn(
      [
        `YEA_PRINCIPAL_PUB: ${pinned.why}. Servers that check approvals accept none until it's pinned, where they run:`,
        ...pinRecipe(p?.public ?? '<your principal key>').map(
          (l) => `    ${l}`,
        ),
      ].join('\n'),
    );
  }
}

/** The doctor's report on each saved grant. */
async function reportGrants(r: Report, a: KeyPair | null) {
  const grants = loadGrants('grants');

  if (!grants.length) {
    r.warn(
      [
        `no grants: your agent can read but not act. Issue one ${WHERE_PRINCIPAL_IS}, and import it here:`,
        `    yea grant --to ${a?.public ?? '<agent key>'} …   (there)`,
        `    ${self('grant-import <token>')}   (here)`,
        `  or, to try things on one machine: ${self('install --with-principal')}`,
      ].join('\n'),
    );
  }

  for (const g of grants) {
    try {
      reportGrant(r, await inspectGrant(g), a);
    } catch {
      r.warn(
        `a saved grant in ${home()}/grants is unreadable: re-issue it ${WHERE_PRINCIPAL_IS}`,
      );
    }
  }
}

function reportGrant(r: Report, info: GrantInfo, a: KeyPair | null) {
  const now = unixNow();
  const cav = info.blocks.flatMap((b) => b.caveats);
  const exp = Math.min(
    ...cav.flatMap((c) => ('exp' in c && c.exp ? [c.exp] : [])),
    Infinity,
  );
  const scope =
    cav
      .find((c): c is { svc: string[] } => 'svc' in c && !!c.svc)
      ?.svc.join(', ') ?? 'all services';
  const id = info.id.slice(0, 10);
  const to = `--to ${a?.public ?? '<agent key>'}`;

  if (a && info.holder !== a.public) {
    r.warn(
      `grant ${id} is held by another key, not this agent's: re-issue it ${WHERE_PRINCIPAL_IS}, ${to}`,
    );
  } else if (exp !== Infinity && exp <= now) {
    r.warn(
      `grant ${id} expired ${fmtTime(exp)}: re-issue it ${WHERE_PRINCIPAL_IS}, ${to}`,
    );
  } else {
    r.ok(
      `grant ${id}: ${scope}; ${exp === Infinity ? 'no expiry' : `expires ${fmtTime(exp)}`}`,
    );
  }
}

/** Each added service, which the bridge starts without if it doesn't answer. */
async function checkServices(r: Report) {
  const services = listServices();

  if (!services.length) {
    r.warn(`no services: ${self('add <url>')}`);
  }

  for (const u of services) {
    const t0 = Date.now();
    const down = `the bridge starts without it: start it, or ${self(`remove ${shellWord(u)}`)}`;

    try {
      const b = await helloWithin(u, HELLO_TIMEOUT_MS);

      if (b.kind === 'BRIEF') {
        r.ok(`${u}: ${b.service.name} (${Date.now() - t0} ms)`);
      } else {
        r.warn(`${u}: ${untrustedLens(b)}. ${down}`);
      }
    } catch (e) {
      r.warn(`${u}: ${(e as Error).message}. ${down}`);
    }
  }
}

/**
 * The answer to HELLO from service `u`, connecting included, if it comes within `ms`. Its
 * connection is closed either way: now, or once it's made, if that's later.
 */
async function helloWithin(
  u: string,
  ms: number,
): Promise<WithLens<Brief | ErrorReply>> {
  const connecting = client(u, {});
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${ms / 1000} s`)),
      ms,
    );
  });

  try {
    return await Promise.race([connecting.then((c) => c.hello(200)), late]);
  } finally {
    clearTimeout(timer);
    connecting.then(
      (c) => c.close(),
      () => {
        // It didn't connect: its error is the line's, or the timeout is.
      },
    );
  }
}
