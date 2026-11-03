/** The `yea` command line: --version, per-command help, and usage errors (#320). */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/cli/commands.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), 'yea-cli-'));
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** Run `yea …args` in an empty home; never waits on a terminal. */
function yea(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, YEA_HOME: HOME, YEA_DEBUG: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';

    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (status) => resolve({ status, out, err }));
  });
}

const STACK = /^\s+at /m;

describe('yea --version', () => {
  it.each(['--version', '-v'])('%s prints the version', async (flag) => {
    expect(await yea([flag])).toEqual({
      status: 0,
      out: `${VERSION}\n`,
      err: '',
    });
  });
});

describe.concurrent('yea help', () => {
  it('lists every command', async () => {
    const r = await yea(['help']);

    expect(r.status).toBe(0);

    for (const name of COMMANDS.keys()) {
      if (name !== 'setup') {
        expect(r.out).toMatch(new RegExp(`^  ${name} `, 'm'));
      }
    }

    expect((await yea([])).out).toBe(r.out);
    expect((await yea(['--help'])).out).toBe(r.out);
  });

  it.each([...COMMANDS])(
    "yea %s --help shows the command's usage, every flag and an example",
    async (name, command) => {
      const [r, short, viaHelp] = await Promise.all([
        yea([name, '--help']),
        yea([name, '-h']),
        yea(['help', name]),
      ]);

      expect(r).toMatchObject({ status: 0, err: '' });
      expect(r.out).toContain(`usage: yea ${command.usage}`);
      expect(r.out).toContain(`\nexample:\n  ${command.example}`);
      expect(command.example).toMatch(
        new RegExp(`\\b${command.usage.split(' ')[0]}\\b`),
      );
      expect(r.out).toContain('-h, --help');

      for (const flag of Object.keys(command.flags)) {
        expect(r.out).toMatch(new RegExp(`--${flag}\\b`));
      }

      expect(short.out).toBe(r.out);
      expect(viaHelp.out).toBe(r.out);
    },
  );
});

describe.concurrent('usage errors', () => {
  it('an unknown option names the command and exits 2, without a stack trace', async () => {
    const r = await yea(['init', '--foo']);

    expect(r.status).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/^yea: unknown option --foo for 'init'\n/);
    expect(r.err).toContain("run 'yea init --help' for usage");
    expect(r.err).not.toMatch(STACK);
  });

  it('suggests a close flag', async () => {
    const r = await yea(['grant', '--tx', 'ed25519:x']);

    expect(r.status).toBe(2);
    expect(r.err).toMatch(
      /^yea: unknown option --tx for 'grant'\ndid you mean --to\?\n/,
    );
  });

  it("refuses a flag another command takes, and doesn't guess at a one-letter one", async () => {
    const r = await yea(['init', '--json']);
    const short = await yea(['grant', '-y']);

    expect(r.status).toBe(2);
    expect(r.err).toMatch(/^yea: unknown option --json for 'init'\n/);
    expect(short.status).toBe(2);
    expect(short.err).not.toContain('did you mean');
  });

  it('an unknown command suggests a close one and exits 2', async () => {
    for (const args of [['grnt'], ['help', 'grnt']]) {
      const r = await yea(args);

      expect(r.status).toBe(2);
      expect(r.err).toMatch(
        /^yea: unknown command 'grnt'\ndid you mean 'grant'\?\nrun 'yea help'/,
      );
      expect(r.err).not.toMatch(STACK);
    }
  });

  it('an unknown option before any command exits 2', async () => {
    const r = await yea(['--verison']);

    expect(r.status).toBe(2);
    expect(r.err).toMatch(
      /^yea: unknown option --verison\ndid you mean --version\?\n/,
    );
  });

  it('a flag without its value, or a switch given one, exits 2', async () => {
    for (const [args, message] of [
      [['grant', '--to'], '--to needs a value'],
      [['grant', '--to', '--risk', 'low'], '--to needs a value'],
      [['grant', '--json=1'], 'unknown option --json'],
      [['install', '--local=yes'], '--local takes no value'],
    ]) {
      const r = await yea(args as string[]);

      expect(r.status).toBe(2);
      expect(r.err).toMatch(new RegExp(`^yea: ${message} for '`));
      expect(r.err).not.toMatch(STACK);
    }
  });

  it('a service command without its url exits 2', async () => {
    const r = await yea(['hello']);

    expect(r.status).toBe(2);
    expect(r.err).toMatch(/^yea: missing <url> for 'hello'\n/);
  });

  it('YEA_DEBUG=1 shows the stack trace too', async () => {
    const r = await yea(['init', '--foo'], { YEA_DEBUG: '1' });

    expect(r.status).toBe(2);
    expect(r.err).toMatch(STACK);
    expect(r.err).toContain("yea: unknown option --foo for 'init'");
  });
});
