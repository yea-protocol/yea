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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TEST_DRIVE_REEXEC, testDriveNpxArgs } from '../src/cli/launch.js';

const TS = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(TS, 'package.json'), 'utf8'));

/** A copy of the built CLI with no node_modules above it, and a stub npx beside it. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'yea-reexec-'));
  const pkg = join(root, 'pkg');
  const bin = join(root, 'bin');
  const npx = join(bin, 'npx');

  cpSync(join(TS, 'dist'), join(pkg, 'dist'), { recursive: true });
  copyFileSync(join(TS, 'package.json'), join(pkg, 'package.json'));
  mkdirSync(bin);
  // Records its arguments, one per line, then the guard's value; exits 7.
  writeFileSync(
    npx,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/npx-args"\nprintf '%s' "$${TEST_DRIVE_REEXEC}" > "${root}/npx-guard"\nexit 7\n`,
  );
  chmodSync(npx, 0o755);

  return { root, cli: join(pkg, 'dist', 'cli.js'), bin };
}

function testDrive(
  box: ReturnType<typeof sandbox>,
  env: Record<string, string>,
) {
  const base = { ...process.env };

  delete base[TEST_DRIVE_REEXEC];

  return spawnSync(
    process.execPath,
    [box.cli, 'test-drive', '--model', 'm', 'book it'],
    {
      env: {
        ...base,
        PATH: `${box.bin}${delimiter}${process.env.PATH}`,
        ...env,
      },
      encoding: 'utf8',
    },
  );
}

describe('yea test-drive without @anthropic-ai/sdk', () => {
  it('re-runs through npx with @yea-protocol/cli at this version, once', () => {
    expect(testDriveNpxArgs('1.2.3', ['test-drive', 'x'])).toEqual([
      '-y',
      '-p',
      '@yea-protocol/cli@1.2.3',
      '-p',
      '@anthropic-ai/sdk',
      'yea',
      'test-drive',
      'x',
    ]);

    const box = sandbox();
    const r = testDrive(box, {});

    expect(r.status).toBe(7);
    expect(readFileSync(join(box.root, 'npx-args'), 'utf8')).toBe(
      `${testDriveNpxArgs(version, ['test-drive', '--model', 'm', 'book it']).join('\n')}\n`,
    );
    expect(readFileSync(join(box.root, 'npx-guard'), 'utf8')).toBe('1');
  });

  it('stops with install advice when it is already the re-run', () => {
    const box = sandbox();
    const r = testDrive(box, { [TEST_DRIVE_REEXEC]: '1' });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/needs @anthropic-ai\/sdk/);
    expect(r.stderr).toMatch(/npm install @anthropic-ai\/sdk/);
    expect(r.stderr).not.toMatch(/fetching @anthropic-ai\/sdk for/);
    expect(existsSync(join(box.root, 'npx-args'))).toBe(false);
  });
});
