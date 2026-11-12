/** The `yea` command line: --version, per-command help, and usage errors (#320). */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { caveats } from '../src/cli/caveats.js';
import { COMMANDS } from '../src/cli/commands.js';
import { keyPair } from '../src/crypto.js';
import { decodeGrant, delegateGrant, issueGrant } from '../src/grants.js';
import { fmtTime } from '../src/lens.js';

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
/** A well-formed public key, for flags that need one. */
const KEY = 'ed25519:gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q';

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
      // #405: whatever follows a --total's `/` is a period, or it is refused, never a unit.
      [
        ['grant', '--total', 'buy=500USD/week', '--exp', '90d'],
        'bad period "week" in --total buy=500USD/week \\(use e.g. 24h, 7d\\)',
      ],
      [
        ['grant', '--total', 'buy=500USD/7days', '--exp', '90d'],
        'bad period "7days"',
      ],
      [
        ['grant', '--total', 'buy=500USD/0d', '--exp', '90d'],
        'bad period "0d"',
      ],
      [
        ['grant', '--each', 'buy=100USD/1d'],
        '--each buy=100USD/1d: each takes no period',
      ],
      [
        ['grant', '--total', 'buy=500USD/7d'],
        '--total buy=500USD/7d needs --exp',
      ],
      [
        ['delegate', 'pg1.x', '--to', KEY, '--total', 'buy=5/1d'],
        '--total buy=5/1d needs --exp',
      ],
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

// #405: `yea grant` issues a total that counts per period, and it and `yea inspect` say what
// that allows in all (SPEC §6.3, §11).
describe('yea grant and yea inspect with a period', () => {
  it('signs one nbf at 00:00 UTC today, and prints the periods, their end and the worst case', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yea-period-'));
    const env = { YEA_HOME: home, YEA_PRINCIPAL_HOME: '' };

    expect((await yea(['init'], env)).status).toBe(0);

    const g = await yea(
      [
        'grant',
        '--to',
        KEY,
        '--can',
        'buy',
        '--each',
        'buy=100USD',
        '--total',
        'buy=500USD/7d',
        '--exp',
        '90d',
      ],
      env,
    );
    const caveats = decodeGrant(g.out.trim())[0].p.caveats;
    const exp = Number(caveats.find((c) => 'exp' in c)?.exp);
    const nbf = Number(caveats.find((c) => 'nbf' in c)?.nbf);
    // 13 weeks, or 14 when issued in the first 300 s of a UTC day (the nbf is then yesterday's).
    const weeks = Math.ceil((exp - nbf) / 604_800);
    const line = `buy: 500 USD every 7d from ${fmtTime(nbf)} until ${fmtTime(exp)}, at most ${500 * weeks} USD at each service`;

    expect(g.status, g.err).toBe(0);
    expect(caveats).toEqual([
      { can: ['buy'] },
      { exp },
      { each: { of: 'buy', max: 100, unit: 'USD' } },
      { total: { of: 'buy', max: 500, unit: 'USD', every: 604_800 } },
      { nbf },
    ]);
    // 00:00 UTC of the day 300 s before it was issued: at most a day and 300 s before 90 days
    // ahead of exp.
    expect(nbf % 86_400).toBe(0);
    expect(exp - 90 * 86_400 - nbf).toBeGreaterThanOrEqual(300);
    expect(exp - 90 * 86_400 - nbf).toBeLessThan(86_400 + 300);
    expect(g.err).toContain(`\n${line}\n`);

    const i = await yea(['inspect', g.out.trim()], env);

    expect(i.out).toContain(`periods:\n  block 0: ${line}\n`);
  });

  it("anchors a period's nbf on the midnight at or before now − 300 s, which a slower service accepts", () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      const nbfAt = (iso: string) => {
        vi.setSystemTime(new Date(iso));

        const signed = caveats({ total: ['buy=500USD/7d'], exp: '90d' });

        return signed.find((c) => 'nbf' in c);
      };
      const day = Date.parse('2026-11-12T00:00:00Z') / 1000;

      // At 00:00:20 a service 300 s behind is still on the 11th: the period starts then.
      expect(nbfAt('2026-11-12T00:00:20Z')).toEqual({ nbf: day - 86_400 });
      expect(nbfAt('2026-11-12T00:05:00Z')).toEqual({ nbf: day });
      expect(nbfAt('2026-11-12T23:59:59Z')).toEqual({ nbf: day });
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the worst case is per service, unless svc leaves one, and sums it over several', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yea-period-'));
    const env = { YEA_HOME: home, YEA_PRINCIPAL_HOME: '' };

    expect((await yea(['init'], env)).status).toBe(0);

    const flags = ['--to', KEY, '--total', 'buy=500USD/7d', '--exp', '28d'];
    const svc = (...ids: string[]) => ids.flatMap((id) => ['--svc', id]);
    const [none, one, two] = await Promise.all(
      [[], svc('a.example'), svc('a.example', 'b.example')].map((s) =>
        yea(['grant', ...flags, ...s], env),
      ),
    );
    const lastLine = (r: { err: string }) =>
      r.err.split('\n').find((l) => l.startsWith('buy: '));
    // Four weeks, or five when issued in the first 300 s of a UTC day.
    const weeks = (r: { out: string }) => {
      const c = decodeGrant(r.out.trim())[0].p.caveats;
      const at = (k: string) => Number(c.find((x) => k in x)?.[k]);

      return Math.ceil((at('exp') - at('nbf')) / 604_800);
    };

    expect(lastLine(none)).toMatch(
      new RegExp(`, at most ${500 * weeks(none)} USD at each service$`),
    );
    expect(lastLine(one)).toMatch(
      new RegExp(`, at most ${500 * weeks(one)} USD$`),
    );
    expect(lastLine(two)).toMatch(
      new RegExp(
        `, at most ${500 * weeks(two)} USD at each of its 2 services, ${1000 * weeks(two)} USD in all$`,
      ),
    );

    // A delegation that narrows two services to one leaves one: across the chain, as a service checks.
    const agent = await keyPair();
    const root = await issueGrant({
      principal: await keyPair(),
      to: agent.public,
      caveats: [
        { svc: ['a.example', 'b.example'] },
        { total: { of: 'buy', max: 500, unit: 'USD', every: 604_800 } },
        { nbf: 1_790_000_000 },
        { exp: 1_790_000_000 + 604_800 },
      ],
    });
    const narrowed = await delegateGrant(root, {
      holder: agent,
      to: KEY,
      caveats: [{ svc: ['b.example', 'c.example'] }],
    });

    expect((await yea(['inspect', narrowed])).out).toContain(
      ', at most 500 USD\n',
    );
  });

  it('yea inspect works out a worst case past 2^53 exactly', async () => {
    const principal = await keyPair();
    const token = await issueGrant({
      principal,
      to: KEY,
      caveats: [
        { total: { of: 'buy', max: 1, every: 1 } },
        { nbf: -(2 ** 53 - 1) },
        { exp: 1_790_000_000 },
      ],
    });
    const i = await yea(['inspect', token]);

    // 2^53 − 1 + 1790000000 one-second periods; in floating point, one more.
    expect(i.out).toContain(', at most 9007201044740991 at each service\n');
  });

  it("yea delegate prints its block's periods, and yea inspect ends every block's at the earliest exp", async () => {
    const home = mkdtempSync(join(tmpdir(), 'yea-period-'));
    const env = { YEA_HOME: home, YEA_PRINCIPAL_HOME: '' };

    expect((await yea(['init'], env)).status).toBe(0);

    const root = (
      await yea(['grant', '--total', 'buy=500USD/7d', '--exp', '90d'], env)
    ).out.trim();
    const d = await yea(
      [
        'delegate',
        root,
        '--to',
        KEY,
        '--total',
        'buy=100USD/1d',
        '--exp',
        '1d',
      ],
      env,
    );
    const blocks = decodeGrant(d.out.trim());
    const caveat = (i: number, k: string) =>
      Number(blocks[i].p.caveats.find((c) => k in c)?.[k]);
    // The delegation's exp, a day out, is the grant's earliest: both blocks' periods end there.
    const until = caveat(1, 'exp');
    const days = Math.ceil((until - caveat(1, 'nbf')) / 86_400);
    const own = `buy: 100 USD every 1d from ${fmtTime(caveat(1, 'nbf'))} until ${fmtTime(until)}, at most ${100 * days} USD at each service`;

    expect(d.status, d.err).toBe(0);
    expect(until).toBeLessThan(caveat(0, 'exp'));
    expect(d.err).toBe(`\n${own}\n`);

    const i = await yea(['inspect', d.out.trim()], env);

    expect(i.out).toContain(
      `periods:\n  block 0: buy: 500 USD every 7d from ${fmtTime(caveat(0, 'nbf'))} until ${fmtTime(until)}, at most ${500 * Math.ceil((until - caveat(0, 'nbf')) / 604_800)} USD at each service\n  block 1: ${own}\n`,
    );
  });
});
