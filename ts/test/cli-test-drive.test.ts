// #106: without @anthropic-ai/sdk, `yea test-drive` re-runs itself through npx with the CLI
// package (the one with the `yea` bin) and the SDK, once. The built CLI is copied somewhere
// @anthropic-ai/sdk can't be resolved from, and a stub `npx` on PATH records how it was called.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  anthropicSdkSpec,
  TEST_DRIVE_REEXEC,
  testDriveNpxArgs,
} from '../src/cli/test-drive.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const readJson = (path: string) =>
  JSON.parse(readFileSync(join(REPO, path), 'utf8'));
const SDK_PKG = readJson('ts/package.json');
const ARGV = ['test-drive', '--model', 'm', 'book it'];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A copy of the built CLI with no node_modules above it, and a `bin` directory for PATH. With
 * `npxExit`, the directory holds a stub npx that records its arguments, one per line, and the
 * guard's value, then exits with that code; without it, there is no npx at all.
 */
function sandbox(npxExit?: number) {
  const root = mkdtempSync(join(tmpdir(), 'yea-reexec-'));
  const pkg = join(root, 'pkg');
  const bin = join(root, 'bin');

  roots.push(root);
  cpSync(join(REPO, 'ts', 'dist'), join(pkg, 'dist'), { recursive: true });
  copyFileSync(join(REPO, 'ts', 'package.json'), join(pkg, 'package.json'));
  mkdirSync(bin);

  if (npxExit !== undefined) {
    writeFileSync(
      join(bin, 'npx'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/npx-args"\nprintf '%s' "$${TEST_DRIVE_REEXEC}" > "${root}/npx-guard"\nexit ${npxExit}\n`,
    );
    chmodSync(join(bin, 'npx'), 0o755);
  }

  return { root, cli: join(pkg, 'dist', 'cli.js'), bin };
}

/** `yea test-drive …` in the sandbox, with only its bin directory on PATH. */
function testDrive(
  box: ReturnType<typeof sandbox>,
  env: Record<string, string> = {},
) {
  const base = { ...process.env };

  delete base[TEST_DRIVE_REEXEC];

  const r = spawnSync(process.execPath, [box.cli, ...ARGV], {
    env: { ...base, PATH: box.bin, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });

  expect(r.signal).toBeNull();

  return r;
}

const recorded = (box: ReturnType<typeof sandbox>, file: string) =>
  readFileSync(join(box.root, file), 'utf8');

describe('the npx re-run', () => {
  it('runs @yea-protocol/cli at the version, with the Anthropic SDK at its peer range', () => {
    const pkg = {
      version: '1.2.3',
      peerDependencies: { '@anthropic-ai/sdk': '>=0.100.0' },
    };

    expect(testDriveNpxArgs(pkg, ['test-drive', 'x'])).toEqual([
      '-p',
      '@yea-protocol/cli@1.2.3',
      '-p',
      '@anthropic-ai/sdk@>=0.100.0',
      'yea',
      'test-drive',
      'x',
    ]);
    expect(
      anthropicSdkSpec({
        version: '1',
        devDependencies: { '@anthropic-ai/sdk': '^0.128.0' },
      }),
    ).toBe('@anthropic-ai/sdk@^0.128.0');
    expect(anthropicSdkSpec({ version: '1' })).toBe('@anthropic-ai/sdk');
  });

  it('can name the CLI at the SDK version: the packages ship in lockstep', () => {
    const cli = readJson('cli/package.json');

    expect(cli.version).toBe(SDK_PKG.version);
    expect(cli.dependencies['@yea-protocol/sdk']).toBe(SDK_PKG.version);
    expect(SDK_PKG.peerDependencies['@anthropic-ai/sdk']).toBeTruthy();
  });
});

describe.skipIf(process.platform === 'win32')(
  'yea test-drive without @anthropic-ai/sdk',
  () => {
    it('re-runs through npx once, marking the re-run', () => {
      const box = sandbox(0);
      const r = testDrive(box);

      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(
        /fetching @anthropic-ai\/sdk .*npm install @anthropic-ai\/sdk/,
      );
      expect(recorded(box, 'npx-args')).toBe(
        `${testDriveNpxArgs(SDK_PKG, ARGV).join('\n')}\n`,
      );
      expect(recorded(box, 'npx-guard')).toBe('1');
    });

    it('stops with install advice when it is already the re-run', () => {
      const box = sandbox(0);
      const r = testDrive(box, { [TEST_DRIVE_REEXEC]: '1' });

      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/needs @anthropic-ai\/sdk/);
      expect(r.stderr).toMatch(/npm install @anthropic-ai\/sdk/);
      expect(r.stderr).not.toMatch(/fetching @anthropic-ai\/sdk/);
      expect(existsSync(join(box.root, 'npx-args'))).toBe(false);
    });

    it("passes a failed re-run's exit code on, without install advice", () => {
      const r = testDrive(sandbox(7));

      expect(r.status).toBe(7);
      expect(r.stderr).not.toMatch(/failed/);
      // Only the "fetching…" line mentions installing.
      expect(r.stderr.match(/npm install/g)).toHaveLength(1);
    });

    it('gives install advice when there is no npx', () => {
      const r = testDrive(sandbox());

      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(
        /could not run npx .*ENOENT.*npm install @anthropic-ai\/sdk/,
      );
    });
  },
);
