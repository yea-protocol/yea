/** Commands that launch something: the test drive, the demo, the example services and bridges. */
import { principalKey } from '../home.js';
import { die, type Options } from './shared.js';

/** Principals whose grants a local service trusts: YEA_TRUST, else the principal key here. */
async function trustedPrincipals(): Promise<string[]> {
  const trust = (process.env.YEA_TRUST ?? '').split(',').filter(Boolean);
  const p = await principalKey();

  if (p && !trust.length) {
    trust.push(p.public);
  }

  return trust;
}

// ---- try it ----

/** Set on the `yea` that test-drive re-runs through npx, so that one never re-runs again. */
export const TEST_DRIVE_REEXEC = 'YEA_TEST_DRIVE_REEXEC';

/** How to install the Anthropic SDK, for every message that gives up on fetching it. */
const INSTALL_HINT = 'npm install @anthropic-ai/sdk';

/** What of package.json the re-run reads: the version, and the Anthropic SDK range it accepts. */
export interface PackageInfo {
  version: string;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** `@anthropic-ai/sdk` at the range this package declares for it (its optional peer). */
export function anthropicSdkSpec(pkg: PackageInfo): string {
  const name = '@anthropic-ai/sdk';
  const range = pkg.peerDependencies?.[name] ?? pkg.devDependencies?.[name];

  return range ? `${name}@${range}` : name;
}

/**
 * The npx arguments that re-run `yea <argv>` with the Anthropic SDK beside it: the `yea` bin
 * lives in @yea-protocol/cli (the SDK has none), which ships at the SDK's version. No `-y`, so
 * npx asks a person at a terminal before installing (and assumes yes without one).
 */
export function testDriveNpxArgs(pkg: PackageInfo, argv: string[]): string[] {
  return [
    '-p',
    `@yea-protocol/cli@${pkg.version}`,
    '-p',
    anthropicSdkSpec(pkg),
    'yea',
    ...argv,
  ];
}

/** Whether @anthropic-ai/sdk can be imported from here. */
async function hasAnthropicSdk(): Promise<boolean> {
  try {
    await import('@anthropic-ai/sdk');

    return true;
  } catch {
    return false;
  }
}

/**
 * Run `yea <argv>` again through npx with the Anthropic SDK, once: a run that is itself the
 * re-run stops with install advice instead, so a `yea` that still can't see the SDK can't loop.
 */
async function reexecWithAnthropicSdk(argv: string[]): Promise<never> {
  if (process.env[TEST_DRIVE_REEXEC]) {
    die(
      "yea test-drive needs @anthropic-ai/sdk, and this yea still can't load it after npx fetched it.\n" +
        `  install it where yea can find it: ${INSTALL_HINT}\n` +
        '  (for a global yea: npm install -g @yea-protocol/cli @anthropic-ai/sdk)',
    );
  }

  // Keep @yea-protocol/sdk dependency-free: fetch the SDK only for this command.
  const { spawnSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const { constants } = await import('node:os');
  const pkg: PackageInfo = createRequire(import.meta.url)('../../package.json');

  console.error(
    `fetching @anthropic-ai/sdk for the test drive through npx (or install it: ${INSTALL_HINT})…`,
  );

  const r = spawnSync('npx', testDriveNpxArgs(pkg, argv), {
    stdio: 'inherit',
    env: { ...process.env, [TEST_DRIVE_REEXEC]: '1' },
  });

  if (r.error) {
    die(
      `yea test-drive could not run npx to fetch @anthropic-ai/sdk (${r.error.message}); install it instead: ${INSTALL_HINT}`,
    );
  }

  // A failed re-run may be the test drive's own failure (an API error, Ctrl-C): pass its exit
  // code on as is, or 128 + the signal's number when a signal ended it, as a shell would.
  process.exit(r.status ?? (r.signal ? 128 + constants.signals[r.signal] : 1));
}

export async function cmdTestDrive(rest: string[], o: Options, argv: string[]) {
  if (!(await hasAnthropicSdk())) {
    await reexecWithAnthropicSdk(argv);
  }

  const { testDrive } = await import('../testdrive.js');

  await testDrive({ model: o.model, prompt: rest.join(' ') || undefined });
  process.exit(0);
}

export async function cmdDemo() {
  const { runDemo } = await import('../examples/demo.js');

  await runDemo();
  process.exit(0);
}

export async function cmdExamples(_rest: string[], o: Options) {
  const { calendar, shop, billing } = await import('../examples/index.js');
  const { listen } = await import('../node.js');
  const trust = await trustedPrincipals();
  const port = Number(o.port ?? 7447);

  await listen(calendar({ trust }), { port, host: o.host });
  await listen(shop({ trust }), { port: port + 2, host: o.host });
  await listen(billing({ trust }), { port: port + 4, host: o.host });
  console.error(
    `✓ calendar yea://127.0.0.1:${port} · shop yea://127.0.0.1:${port + 2} · billing yea://127.0.0.1:${port + 4} · trusting ${trust.length} principal(s)${trust.length ? '' : ' (run yea init first to commit anything)'}\n  try: yea do yea://127.0.0.1:${port} calendar.reschedule event=Ana`,
  );
}

// ---- bridges ----

export async function cmdOpenapi(rest: string[], o: Options) {
  const { fromOpenAPI, loadOpenAPI } = await import('../openapi.js');
  const { listen, serveHttp } = await import('../node.js');
  const { PRESETS, presetOptions } = await import('../presets.js');
  const preset = o.preset
    ? (PRESETS[o.preset] ??
      die(
        `unknown preset ${o.preset}; one of: ${Object.keys(PRESETS).join(', ')}`,
      ))
    : null;

  for (const e of preset?.env ?? []) {
    if (!process.env[e]) {
      console.error(
        `note: ${e} is not set; ${o.preset} will only do what works without it`,
      );
    }
  }

  const spec = await loadOpenAPI(
    preset?.spec ??
      rest[0] ??
      die(
        'usage: yea openapi <spec.json|url> [--base <url>]  (or --preset ' +
          Object.keys(PRESETS).join('|') +
          ')',
      ),
  );
  const headers = {
    ...(preset ? presetOptions(preset).headers : {}),
    ...headerFlags(o),
  };
  const trust = await trustedPrincipals();
  const svc = fromOpenAPI(spec, {
    ...(preset ? presetOptions(preset) : {}),
    ...(o.base ? { baseUrl: o.base } : {}),
    ...(o.id ? { id: o.id } : {}),
    ...(o.prefix ? { prefix: o.prefix } : {}),
    headers,
    trust,
  });
  const port = Number(o.port ?? 7447);

  await listen(svc, { port, host: o.host });

  if (o.http) {
    await serveHttp(svc, { port: Number(o.http), host: o.host });
  }

  const count = (kind: string) =>
    svc.capabilities.filter((c) => c.kind === kind).length;

  console.error(
    `✓ ${svc.id}: ${svc.capabilities.length} capabilities (${count('ask')} ask, ${count('intent')} intent)\n  yea://127.0.0.1:${port}${o.http ? `  ·  http://127.0.0.1:${o.http}/yea` : ''}\n  trusting ${trust.length} principal(s) for writes\n  try: yea hello yea://127.0.0.1:${port}`,
  );
}

/** --header "K: V" flags as a header map. */
const headerFlags = (o: Options) =>
  Object.fromEntries(
    (o.header ?? []).map((h) => [
      h.slice(0, h.indexOf(':')).trim(),
      h.slice(h.indexOf(':') + 1).trim(),
    ]),
  );

/** `yea mcp` lives in @yea-protocol/cli, which depends on @yea-protocol/mcp; the SDK can't. */
export async function cmdMcp() {
  die(
    'yea mcp runs from @yea-protocol/cli: npx -y @yea-protocol/cli mcp [<url> …]',
  );
}
