import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as P from '../src/index.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function run(home: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, 'service-id', ...args], {
    env: { ...process.env, YEA_HOME: home },
    encoding: 'utf8',
  });

  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

describe('yea service-id', () => {
  it("prints the public key of a server's seed", async () => {
    const home = mkdtempSync(join(tmpdir(), 'yea-sid-'));
    const server = await P.keyPair();

    mkdirSync(join(home, 'server'), { mode: 0o700 });
    writeFileSync(join(home, 'server', 'files.key'), `${server.seed}\n`, {
      mode: 0o600,
    });

    expect(run(home, 'files')).toMatchObject({ status: 0, out: server.public });
  });

  it('refuses a bad name or a missing key', () => {
    const home = mkdtempSync(join(tmpdir(), 'yea-sid-'));

    expect(run(home, '../x').status).not.toBe(0);
    expect(run(home, 'nope').err).toMatch(/start the server once/);
    expect(run(home).err).toMatch(/usage: yea service-id <name>/);
  });
});
