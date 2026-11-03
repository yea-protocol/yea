/** The `yea` command line: --version, per-command help, and usage errors (#320). */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Run every row's `yea …args` at once, each with its expected message. */
const runAll = (rows: [string[], string][]) =>
  Promise.all(
    rows.map(async ([args, message]) => ({
      args,
      message,
      r: await yea(args),
    })),
  );

describe('yea --version', () => {
  it.each(['--version', '-v'])('%s prints the version', async (flag) => {
    expect(await yea([flag])).toEqual({
      status: 0,
      out: `${VERSION}\n`,
      err: '',
    });
  });

  it('reads it from package.json when it runs, so a release bump carries through', () => {
    const pkg = mkdtempSync(join(tmpdir(), 'yea-version-'));

    cpSync(
      fileURLToPath(new URL('../dist', import.meta.url)),
      join(pkg, 'dist'),
      {
        recursive: true,
      },
    );
    writeFileSync(join(pkg, 'package.json'), '{"version":"9.8.7-test"}');

    const r = spawnSync(process.execPath, [join(pkg, 'dist', 'cli.js'), '-v'], {
      encoding: 'utf8',
    });

    expect(r.stdout).toBe('9.8.7-test\n');
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

    for (const args of [[], ['--help'], ['help', 'help'], ['help', '-h']]) {
      const same = await yea(args);

      expect(same).toMatchObject({ status: 0, err: '' });
      expect(same.out).toBe(r.out);
    }
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
      expect(r.out).toContain(`\nexample\n  ${command.example}`);
      expect(command.example).toMatch(
        new RegExp(`^yea ${command.usage.split(' ')[0]}\\b`),
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

  it("a command's flag before the command says flags go after it", async () => {
    const r = await yea(['--json', 'hello', 'yea://127.0.0.1:1']);

    expect(r.status).toBe(2);
    expect(r.err).toMatch(
      /^yea: unknown option --json\nflags go after the command: yea hello … --json\n/,
    );

    const short = await yea(['-y', 'install']);

    expect(short.status).toBe(2);
    expect(short.err).toMatch(
      /^yea: unknown option -y\nflags go after the command: yea install … -y\n/,
    );
  });

  it('yea help with a flag for a topic says it is an unknown option', async () => {
    const r = await yea(['help', '--verison']);

    expect(r.status).toBe(2);
    expect(r.err).toMatch(
      /^yea: unknown option --verison\ndid you mean --version\?\n/,
    );
  });

  it('an unknown help topic with nothing close gets no suggestion', async () => {
    const r = await yea(['help', 'nope']);

    expect(r.status).toBe(2);
    expect(r.err).not.toContain('did you mean');
  });

  it('a missing argument or required flag exits 2', async () => {
    for (const { args, message, r } of await runAll([
      [['inspect'], "missing <token> for 'inspect'"],
      [['service-id'], "missing <name> for 'service-id'"],
      [['delegate', 'pg1.x'], "missing --to <key> for 'delegate'"],
      [['ask', 'yea://127.0.0.1:1'], "missing <capability> for 'ask'"],
      [['commit', 'yea://127.0.0.1:1', 'p_1'], "missing <hash> for 'commit'"],
      [
        ['openapi'],
        "missing <spec.json|url> or --preset for 'openapi'\npresets: ",
      ],
      [
        ['openapi', '--preset', 'nope'],
        "unknown preset nope for 'openapi'\npresets: ",
      ],
    ])) {
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.err).toMatch(new RegExp(`^yea: ${message}`));
      expect(r.err).toContain('--help');
    }
  });

  it('a bad flag or argument value exits 2, before connecting or reading a key', async () => {
    for (const { args, message, r } of await runAll([
      [['grant', '--exp', '5x'], 'bad duration 5x'],
      [['grant', '--each', 'spend'], 'bad limit spend'],
      [['ask', 'yea://127.0.0.1:1', 'cal.x', 'oops'], 'expected key=value'],
      [['service-id', '../x'], 'bad server name'],
      [['grant', '--verbs', 'ASK,FOO'], 'bad verb "FOO" \\(one of HELLO,ASK,'],
      [['grant', '--verbs', ''], 'bad verb ""'],
      [['grant', '--svc', ''], '--svc needs a non-empty value'],
      [['grant', '--can', ' '], '--can needs a non-empty value'],
      [
        ['grant', '--exp', '99999999999999999999d'],
        'bad duration .* \\(too long\\)',
      ],
      [['grant', '--to', 'notakey'], 'bad --to "notakey": not a public key'],
      [['grant', '--to='], 'bad --to "": not a public key'],
      [['delegate', 'pg1.x', '--to', 'notakey'], 'bad --to "notakey"'],
      [
        ['install', '--target', 'nope'],
        "unknown target nope for 'install'\ntargets: ",
      ],
      [
        ['uninstall', '--target', 'cursor,nope'],
        "unknown target nope for 'uninstall'\ntargets: ",
      ],
    ])) {
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.err).toMatch(new RegExp(`^yea: ${message}`));
      expect(r.err).not.toContain('ECONNREFUSED');
    }
  });

  it("refuses an argument the command doesn't take, instead of dropping it", async () => {
    for (const { args, message, r } of await runAll([
      [['grant', 'x'], "unexpected argument x for 'grant'\nrun "],
      [['init', 'x'], "unexpected argument x for 'init'\nrun "],
      [['add', 'yea://a', 'yea://b'], "unexpected argument yea://b for 'add'"],
      [['inspect', 'pg1.t', 'x'], "unexpected argument x for 'inspect'"],
      [
        ['install', 'cursor'],
        "unexpected argument cursor for 'install'\ndid you mean --target cursor\\?",
      ],
      [
        ['grant', 'low'],
        "unexpected argument low for 'grant'\ndid you mean --risk low\\?",
      ],
      [
        ['grant', '--svc', 'cal.example', 'shop.example'],
        "unexpected argument shop.example for 'grant'\n--svc takes one value; repeat it",
      ],
      [
        ['grant', '--verbs', 'ASK', 'INTENT'],
        "unexpected argument INTENT for 'grant'\n--verbs takes one value: <A,B>",
      ],
    ])) {
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.err).toMatch(new RegExp(`^yea: ${message}`));
    }

    // Commands whose usage ends in `…` take any number.
    expect(
      (await yea(['ask', 'yea://127.0.0.1:1', 'c', 'a=1', 'b=2'])).err,
    ).not.toContain('unexpected argument');
    // --help still wins.
    expect((await yea(['init', 'x', '--help'])).status).toBe(0);
  });

  it('escapes control characters from argv in a usage error', async () => {
    const r = await yea(['init', '--\x1b[31mx']);

    expect(r.status).toBe(2);
    expect(r.err).not.toContain('\x1b');
    expect(r.err).toMatch(/^yea: unknown option --\\u\{1b\}\[31mx for 'init'/);
  });

  it('keeps a newline in argv from forging a line of the message', async () => {
    const r = await yea(['init', '--foo\ndid you mean --evil?']);

    expect(r.status).toBe(2);
    expect(r.err.split('\n')).toEqual([
      "yea: unknown option --foo\\u{a}did you mean --evil? for 'init'",
      "run 'yea init --help' for usage",
      '',
    ]);
  });

  it('a flag without its value, or a switch given one, exits 2', async () => {
    for (const { args, message, r } of await runAll([
      [['grant', '--to'], '--to needs a value'],
      [['grant', '--to', '--risk', 'low'], '--to needs a value'],
      [['grant', '--json=1'], 'unknown option --json'],
      [['install', '--local=yes'], '--local takes no value'],
    ])) {
      expect(r.status, args.join(' ')).toBe(2);
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
