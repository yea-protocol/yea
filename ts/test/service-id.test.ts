import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

    expect(run(home, '../x').err).toMatch(/bad server name/);
    expect(run(home, 'nope').err).toMatch(/start the server once/);
    expect(run(home).err).toMatch(/usage: yea service-id <name>/);
  });

  it('refuses a key file that is malformed, shared, or a symlink', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yea-sid-'));
    const dir = join(home, 'server');
    const server = await P.keyPair();

    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'bad.key'), 'not a seed\n', { mode: 0o600 });
    writeFileSync(join(dir, 'open.key'), `${server.seed}\n`, { mode: 0o644 });
    chmodSync(join(dir, 'open.key'), 0o644);
    symlinkSync(join(dir, 'open.key'), join(dir, 'link.key'));

    expect(run(home, 'bad').err).toMatch(/does not hold an Ed25519 seed/);
    expect(run(home, 'open').err).toMatch(
      /can be read by other users \(chmod 600 it\)/,
    );
    expect(run(home, 'link').err).toMatch(/is a symlink/);
  });

  it('refuses a key directory others can write, as the server does', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yea-sid-'));
    const dir = join(home, 'server');

    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'files.key'), `${(await P.keyPair()).seed}\n`, {
      mode: 0o600,
    });
    chmodSync(dir, 0o770);
    expect(run(home, 'files').err).toMatch(
      /refusing the server key: .* can be written by other users \(chmod 700 it\)/,
    );
  });
});
