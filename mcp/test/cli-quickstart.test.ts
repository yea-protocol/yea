/**
 * The CLI's quickstart (examples/cli-quickstart.sh, shown in cli/README.md) runs as written:
 * with this checkout's `yea` on PATH, as `npm i -g` puts it, and an empty home where Claude
 * Code is installed, `yea demo`, `yea install` and `yea doctor` each succeed, and the bridge is
 * set up in Claude Code.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tmp } from './helpers.js';

const SCRIPT = fileURLToPath(
  new URL('../../examples/cli-quickstart.sh', import.meta.url),
);
const YEA = fileURLToPath(new URL('../../cli/bin/yea.js', import.meta.url));

/** A folder holding a `yea` that runs this checkout's CLI. */
function yeaOnPath(): string {
  const bin = tmp('yea-bin-');

  writeFileSync(
    join(bin, 'yea'),
    `#!/bin/sh\nexec "${process.execPath}" "${YEA}" "$@"\n`,
    { mode: 0o755 },
  );

  return bin;
}

describe.skipIf(process.platform === 'win32')('the CLI quickstart', () => {
  it('runs line by line in an empty home and sets up Claude Code', () => {
    const home = tmp('yea-home-');

    mkdirSync(join(home, '.claude')); // Claude Code is installed

    const r = spawnSync('sh', ['-e', SCRIPT], {
      env: { PATH: `${yeaOnPath()}:${process.env.PATH ?? ''}`, HOME: home },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const out = `${r.stdout}${r.stderr}`;

    expect(r.status, out).toBe(0);
    expect(out).toContain('✔ done.'); // yea demo
    expect(existsSync(join(home, '.yea', 'agent.key'))).toBe(true); // yea install
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toContain(
      `"${YEA}"`,
    );
    expect(out).toMatch(/✓ Claude Code starts the bridge/); // yea doctor
  });
});
