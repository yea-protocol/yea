/**
 * `yea test-drive`: a real model against the example services, re-run once through npx with
 * the Anthropic SDK when this `yea` can't load it.
 */
import { die, type Options } from './shared.js';

/** Set on the `yea` that test-drive re-runs through npx, so that one never re-runs again. */
export const TEST_DRIVE_REEXEC = 'YEA_TEST_DRIVE_REEXEC';

/** How to install the Anthropic SDK, for every message that gives up on fetching it. */
const INSTALL_HINT = 'npm install @anthropic-ai/sdk';

/** What of package.json the re-run reads: the version, and the Anthropic SDK range it accepts. */
interface PackageInfo {
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

  const { testDrive } = await import('../test-drive.js');

  await testDrive({ model: o.model, prompt: rest.join(' ') || undefined });
  process.exit(0);
}
