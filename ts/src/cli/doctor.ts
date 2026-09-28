/** `yea doctor`: check keys, grants, services and AI-tool registration. */
import type { KeyPair } from '../crypto.js';
import { type GrantInfo, inspectGrant } from '../grants.js';
import { agentKey, home, loadGrants, principalKey } from '../home.js';
import { fmtTime, untrustedLens } from '../lens.js';
import { CLIENTS, listServices } from '../setup.js';
import { printable } from '../text.js';
import { unixNow } from '../util.js';
import { installScope } from './install.js';
import { client, type Options } from './shared.js';

const ok = (m: string) => console.log(`✓ ${m}`);
const warn = (m: string) => console.log(`! ${m}`);
const bad = (m: string) => console.log(`✗ ${m}`);

export async function cmdDoctor(_rest: string[], o: Options) {
  const major = Number(process.versions.node.split('.')[0]);

  if (major >= 20) {
    ok(`node ${process.versions.node}`);
  } else {
    bad(`node ${process.versions.node}: YEA needs node ≥ 20`);
  }

  const a = await agentKey();

  if (a) {
    ok(`agent key ${a.public.slice(0, 24)}…`);
  } else {
    bad('no agent key: run yea install');
  }

  const p = await principalKey();

  if (p) {
    warn(
      `principal key is readable here (${process.env.YEA_PRINCIPAL_HOME ?? home()}). Fine for trying things; for real use keep it away from agents (SECURITY.md)`,
    );
  } else {
    ok('principal key is not on this machine (recommended)');
  }

  await reportGrants(a);
  await checkServices(o);
  checkRegistration(o);
}

/** The doctor's report on each saved grant. */
async function reportGrants(a: KeyPair | null) {
  const grants = loadGrants('grants');

  if (!grants.length) {
    bad(
      'no grants: your agent can read but not act. yea grant … (or yea install)',
    );
  }

  for (const g of grants) {
    try {
      reportGrant(await inspectGrant(g), a);
    } catch {
      bad('a saved grant is unreadable');
    }
  }
}

function reportGrant(info: GrantInfo, a: KeyPair | null) {
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
  const holder = a && info.holder === a.public ? '' : ' (held by another key!)';

  if (exp !== Infinity && exp <= now) {
    bad(`grant ${info.id.slice(0, 10)} expired ${fmtTime(exp)}${holder}`);
  } else {
    ok(
      `grant ${info.id.slice(0, 10)}: ${scope}; ${exp === Infinity ? 'no expiry' : `expires ${fmtTime(exp)}`}${holder}`,
    );
  }
}

async function checkServices(o: Options) {
  const services = listServices();

  if (!services.length) {
    warn('no services: yea add <url>');
  }

  for (const u of services) {
    const t0 = Date.now();

    try {
      const c = await client(u, o);
      const b = await c.hello(200);

      c.close();

      if (b.kind === 'BRIEF') {
        ok(printable(`${u}: ${b.service.name} (${Date.now() - t0} ms)`));
      } else {
        bad(`${printable(u)}: ${untrustedLens(b)}`);
      }
    } catch (e) {
      bad(printable(`${u}: ${(e as Error).message}`));
    }
  }
}

function checkRegistration(o: Options) {
  const scope = installScope(o);
  const installed = Object.values(CLIENTS)
    .filter((t) => {
      try {
        return t.installed(scope);
      } catch {
        return false;
      }
    })
    .map((t) => t.name);

  if (installed.length) {
    ok(`registered with: ${installed.join(', ')}`);
  } else {
    warn('not registered with any AI tool: yea install');
  }
}
