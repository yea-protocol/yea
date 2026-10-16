/**
 * The npx re-run of `yea test-drive` (#106): without `@anthropic-ai/sdk`, `yea` runs itself once
 * more through npx with the CLI package and the Anthropic SDK beside it. Only node builtins are
 * imported here, so the check runs even where nothing else of the test drive would load.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:os';

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

/** Print `message` and exit 1, as the CLI's `die` does. */
export function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

/** `@anthropic-ai/sdk` at the range this package declares for it (its optional peer). */
export function anthropicSdkSpec(pkg: PackageInfo): string {
  const name = '@anthropic-ai/sdk';
  const range = pkg.peerDependencies?.[name] ?? pkg.devDependencies?.[name];

  return range ? `${name}@${range}` : name;
}

/**
 * The npx arguments that re-run `yea <argv>` with the Anthropic SDK beside it: the `yea` bin
 * lives in @yea-protocol/cli, which ships at this package's version. No `-y`, so npx asks a
 * person at a terminal before installing (and assumes yes without one).
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
export async function hasAnthropicSdk(): Promise<boolean> {
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
export function reexecWithAnthropicSdk(argv: string[]): never {
  if (process.env[TEST_DRIVE_REEXEC]) {
    stop(
      "yea test-drive needs @anthropic-ai/sdk, and this yea still can't load it after npx fetched it.\n" +
        `  install it where yea can find it: ${INSTALL_HINT}\n` +
        '  (for a global yea: npm install -g @yea-protocol/cli @anthropic-ai/sdk)',
    );
  }

  const pkg: PackageInfo = createRequire(import.meta.url)('../../package.json');

  console.error(
    `fetching @anthropic-ai/sdk for the test drive through npx (or install it: ${INSTALL_HINT})…`,
  );

  // The child's environment, not this process's: the guard is set for the re-run only.
  const r = spawnSync('npx', testDriveNpxArgs(pkg, argv), {
    stdio: 'inherit',
    env: { ...process.env, [TEST_DRIVE_REEXEC]: '1' },
  });

  if (r.error) {
    stop(
      `yea test-drive could not run npx to fetch @anthropic-ai/sdk (${r.error.message}); install it instead: ${INSTALL_HINT}`,
    );
  }

  // A failed re-run may be the test drive's own failure (an API error, Ctrl-C): pass its exit
  // code on as is, or 128 + the signal's number when a signal ended it, as a shell would.
  process.exit(r.status ?? (r.signal ? 128 + constants.signals[r.signal] : 1));
}
