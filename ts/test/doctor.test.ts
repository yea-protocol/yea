/** `yea install` from a checkout, and `yea doctor` starting what each AI tool would start (#321). */
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { handshake } from '../src/cli/doctor/handshake.js';
import { launchLine } from '../src/cli/doctor/registration.js';
import { self } from '../src/cli/shared.js';
import { PORTABLE_BRIDGE, shellWord } from '../src/setup/bridge-command.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(
  /[\\/]$/,
  '',
);
const BIN = join(REPO, 'cli', 'bin', 'yea.js');
/** `yea` as install and doctor name it, run from this checkout. */
const SELF = `node ${shellWord(BIN)}`;

/** `s`, matched literally in a regular expression. */
const literal = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/** A whole line of output: `text` as a pattern, with `self` for how yea is named. */
const lineOf = (text: string) =>
  new RegExp(`^${text.replaceAll('<self>', literal(SELF))}$`, 'm');
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'yea-doctor-')));

/**
 * An MCP server for doctor to start: `ok` answers `initialize`, `silent` never does, `exit`
 * exits first and `error` answers with a JSON-RPC error. Each start is appended to `log`.
 */
const FAKE = join(SCRATCH, 'fake-mcp.mjs');

writeFileSync(
  FAKE,
  `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [mode = 'ok', log] = process.argv.slice(2);
if (log) appendFileSync(log, 'start\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id } = JSON.parse(line);
  if (mode === 'exit') process.exit(3);
  if (mode === 'silent') return;
  const reply = mode === 'error'
    ? { error: { code: -32603, message: 'no thanks' } }
    : { result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...reply }) + '\\n');
});
`,
);

/** A new person on this machine: an empty home, with YEA's home inside it. */
interface User {
  home: string;
  env: Record<string, string>;
}

function user(): User {
  const home = mkdtempSync(join(SCRATCH, 'home-'));

  return {
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      APPDATA: join(home, 'AppData'),
      YEA_HOME: join(home, '.yea'),
      YEA_PRINCIPAL_HOME: '',
      YEA_PRINCIPAL_PUB: '',
      YEA_DEBUG: '',
    },
  };
}

interface Run {
  status: number | null;
  out: string;
  err: string;
}

/** Run `node <cli> …args` as `u`; never waits on a terminal. */
function yea(
  u: User,
  args: string[],
  o: { cli?: string; cwd?: string; env?: Record<string, string> } = {},
): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [o.cli ?? CLI, ...args], {
      cwd: o.cwd ?? u.home,
      env: { ...process.env, ...u.env, ...o.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';

    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (status) => resolve({ status, out, err }));
  });
}

/** The config file `yea install` names for `tool` in its output. */
function configFile(out: string, tool: string): string {
  const m = new RegExp(`^✓ ${tool}: MCP server "yea" → (.+)$`, 'm').exec(out);

  if (!m) {
    throw new Error(`no config file for ${tool} in:\n${out}`);
  }

  return m[1];
}

/** Replace the `yea` entry under `key` in the JSON config `file`. */
function register(file: string, entry: unknown, key = 'mcpServers') {
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ ...cfg, [key]: { ...cfg[key], yea: entry } }),
  );
}

/** This machine's agent key, as `yea whoami` shows it. */
async function agentOf(u: User): Promise<string> {
  const { out } = await yea(u, ['whoami']);
  const m = /^agent\s+(\S+)$/m.exec(out);

  if (!m) {
    throw new Error(`no agent key in:\n${out}`);
  }

  return m[1];
}

/** A user with an agent key and Claude Code registered with `entry` (or this checkout). */
async function installed(entry?: object): Promise<User> {
  const u = user();
  const r = await yea(u, ['install', '--target', 'claude-code']);

  expect(r).toMatchObject({ status: 0, err: '' });

  if (entry) {
    register(join(u.home, '.claude.json'), entry);
  }

  return u;
}

const fake = (mode = 'ok', log?: string) => ({
  command: process.execPath,
  args: [FAKE, mode, ...(log ? [log] : [])],
});

/**
 * A yea clone in a folder named `name`, whose bin is the script `bin`: unbuilt, built after its
 * last source change, or built before it (`stale`).
 */
function clone(
  bin: string,
  build: 'none' | 'fresh' | 'stale',
  name = 'clone',
): string {
  const root = join(mkdtempSync(join(SCRATCH, 'clones-')), name);
  const files: Record<string, string> = {
    'package.json': '{"name":"yea-monorepo"}',
    'cli/package.json': '{"type":"module"}',
    'cli/bin/yea.js': bin,
    'ts/src/cli.ts': '',
    'mcp/src/bridge.ts': '',
    ...(build === 'none'
      ? {}
      : { 'ts/dist/cli.js': '', 'mcp/dist/bridge.js': '' }),
  };

  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }

  const built = Date.now() / 1000 + (build === 'stale' ? -100 : 100);

  for (const f of ['ts/dist/cli.js', 'mcp/dist/bridge.js']) {
    if (existsSync(join(root, f))) {
      utimesSync(join(root, f), built, built);
    }
  }

  return root;
}

/** The entry `yea install` writes for clone `root`, from this node. */
const cloneEntry = (root: string) => ({
  command: process.execPath,
  args: [join(root, 'cli', 'bin', 'yea.js'), 'mcp'],
});

describe.concurrent('yea install from a checkout', () => {
  it("registers this node and the checkout's bin, says so, and doctor starts it", async () => {
    const u = user();
    const r = await yea(u, ['install', '--target', 'claude-code']);

    expect(r.status).toBe(0);
    expect(r.out).toContain(
      `bridge      ${process.execPath} ${BIN} mcp (this checkout)`,
    );
    expect(
      JSON.parse(readFileSync(join(u.home, '.claude.json'), 'utf8')).mcpServers
        .yea,
    ).toEqual({
      type: 'stdio',
      alwaysLoad: true,
      command: process.execPath,
      args: [BIN, 'mcp'],
    });

    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(/^✓ Claude Code starts the bridge \(\d+ ms\)/m);
    expect(d.out).not.toContain('✗');
    expect(d.status).toBe(0);
  });

  it('a desktop app gets absolute paths and a PATH with node, and doctor starts it with no shell PATH', async () => {
    const u = user();
    const r = await yea(u, ['install', '--target', 'claude-desktop']);
    const entry = JSON.parse(
      readFileSync(configFile(r.out, 'Claude Desktop'), 'utf8'),
    ).mcpServers.yea;

    expect(entry).toMatchObject({
      command: process.execPath,
      args: [BIN, 'mcp'],
    });
    expect(entry.env.PATH.startsWith(dirname(process.execPath))).toBe(true);

    const d = await yea(u, ['doctor'], { env: { PATH: '/usr/bin:/bin' } });

    expect(d.out).toMatch(/^✓ Claude Desktop starts the bridge/m);
    expect(d.status).toBe(0);
  });

  it('--local keeps the portable npx entry in project files, and says why', async () => {
    const u = user();
    const project = mkdtempSync(join(SCRATCH, 'project-'));
    const r = await yea(u, ['install', '--target', 'cursor', '--local'], {
      cwd: project,
    });

    expect(r.status).toBe(0);
    expect(
      JSON.parse(readFileSync(join(project, '.cursor', 'mcp.json'), 'utf8'))
        .mcpServers.yea,
    ).toEqual(PORTABLE_BRIDGE);
    expect(r.out).toMatch(/note: .*npx -y @yea-protocol\/cli mcp/);
  });

  it('--require-interaction writes YEA_REQUIRE_INTERACTION=1, in a project file too, and doctor starts it', async () => {
    const u = user();
    const project = mkdtempSync(join(SCRATCH, 'project-'));
    const on = ['install', '--require-interaction', '--target'];
    const own = await yea(u, [...on, 'claude-code']);
    const local = await yea(u, [...on, 'claude-code', '--local'], {
      cwd: project,
    });
    const entry = (file: string) =>
      JSON.parse(readFileSync(file, 'utf8')).mcpServers.yea;

    expect(own.out).toContain('prompts     Claude Code asks before every call');
    expect(entry(join(u.home, '.claude.json'))).toMatchObject({
      command: process.execPath,
      args: [BIN, 'mcp'],
      env: { YEA_REQUIRE_INTERACTION: '1' },
    });
    expect(local.status).toBe(0);
    expect(entry(join(project, '.mcp.json'))).toMatchObject({
      ...PORTABLE_BRIDGE,
      env: { YEA_REQUIRE_INTERACTION: '1' },
    });

    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(/^✓ Claude Code starts the bridge/m);
    expect(d.status).toBe(0);
  });

  it('says so when a plain install replaces an entry that had YEA_REQUIRE_INTERACTION', async () => {
    const u = user();

    await yea(u, [
      'install',
      '--require-interaction',
      '--target',
      'claude-code',
    ]);

    const again = await yea(u, ['install', '--target', 'claude-code']);

    expect(again.out).toMatch(
      /note: the entry this replaced had YEA_REQUIRE_INTERACTION set.*--require-interaction/,
    );
    expect(
      JSON.parse(readFileSync(join(u.home, '.claude.json'), 'utf8')).mcpServers
        .yea.env,
    ).toBeUndefined();
    expect(
      (await yea(u, ['install', '--target', 'claude-code'])).out,
    ).not.toContain('YEA_REQUIRE_INTERACTION set');
  });

  it('refuses a checkout whose build is older than its source, before writing anything', async () => {
    const root = mkdtempSync(join(SCRATCH, 'clone-'));

    cpSync(join(REPO, 'ts', 'dist'), join(root, 'ts', 'dist'), {
      recursive: true,
    });
    cpSync(join(REPO, 'mcp', 'dist'), join(root, 'mcp', 'dist'), {
      recursive: true,
    });
    mkdirSync(join(root, 'ts', 'src'));
    mkdirSync(join(root, 'mcp', 'src'));
    writeFileSync(join(root, 'package.json'), '{"name":"yea-monorepo"}');
    writeFileSync(join(root, 'ts', 'package.json'), '{"version":"0.0.0"}');
    writeFileSync(join(root, 'ts', 'src', 'cli.ts'), '');

    const later = Date.now() / 1000 + 60;

    utimesSync(join(root, 'ts', 'src', 'cli.ts'), later, later);

    const u = user();
    const r = await yea(u, ['install', '--target', 'claude-code'], {
      cli: join(root, 'ts', 'dist', 'cli.js'),
    });

    expect(r.status).toBe(1);
    expect(r.err).toContain(
      `Build it first: cd ${shellWord(root)} && npm run build`,
    );
    expect(existsSync(join(u.home, '.claude.json'))).toBe(false);
    expect(existsSync(join(u.home, '.yea', 'agent.key'))).toBe(false);
  });
});

describe.concurrent('yea doctor: grants', () => {
  it('"no grants" is a warning naming both ways to get one, and doctor still exits 0', async () => {
    const u = await installed(fake());
    const agent = await agentOf(u);
    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(/^! no grants: your agent can read but not act/m);
    expect(d.out).toContain(`yea grant --to ${agent}`);
    expect(d.out).toContain(`${SELF} grant-import <token>`);
    expect(d.out).toContain(`${SELF} install --with-principal`);
    expect(d.out).not.toContain('✗');
    expect(d.status).toBe(0);
  });

  it('the one-machine way works: yea install --with-principal, with the pin recipe', async () => {
    const u = user();
    const r = await yea(u, [
      'install',
      '--target',
      'claude-code',
      '--with-principal',
    ]);
    const key = /^principal\s+(ed25519:\S+)/m.exec(r.out)?.[1];

    expect(r.status).toBe(0);
    expect(r.out).toContain(`echo '${key}' | sudo tee /etc/yea/principal.pub`);
    expect(r.out).toContain('YEA_PRINCIPAL_PUB=/etc/yea/principal.pub');
    // The grant is the point here, not the bridge: start the fake server instead.
    register(join(u.home, '.claude.json'), fake());

    const d = await yea(u, ['doctor']);

    expect(d.out).not.toContain('no grants');
    expect(d.out).toMatch(/^✓ grant /m);
    expect(d.status).toBe(0);
  });

  it('the principal-elsewhere way works: yea grant --to there, yea grant-import here', async () => {
    const u = await installed(fake());
    const elsewhere = user();

    expect((await yea(elsewhere, ['init'])).status).toBe(0);

    const g = await yea(elsewhere, [
      'grant',
      '--to',
      await agentOf(u),
      '--risk',
      'low',
      '--exp',
      '30d',
    ]);
    const imported = await yea(u, ['grant-import', g.out.trim()]);

    expect(imported.status).toBe(0);

    const d = await yea(u, ['doctor']);

    expect(d.out).not.toContain('no grants');
    expect(d.out).toMatch(/^✓ grant /m);
    expect(d.out).toMatch(/^✓ principal key is not on this machine/m);
    expect(d.status).toBe(0);
  });

  it("a grant held by another key is a warning that says where it's re-issued", async () => {
    const u = await installed(fake());
    const other = user();

    await yea(other, ['init']);

    const g = await yea(other, ['grant', '--risk', 'low']);

    mkdirSync(join(u.home, '.yea', 'grants'), { recursive: true });
    writeFileSync(join(u.home, '.yea', 'grants', 'other.pg'), g.out);

    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(
      /^! grant [\w-]+ is held by another key.*where your principal key is/m,
    );
    expect(d.status).toBe(0);
  });
});

describe.concurrent('yea doctor: services and the pinned key', () => {
  it("a service that doesn't answer is a warning: the bridge starts without it", async () => {
    const u = await installed(fake());

    writeFileSync(
      join(u.home, '.yea', 'services.json'),
      '["yea://127.0.0.1:9"]',
    );

    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(
      lineOf(
        '! yea://127\\.0\\.0\\.1:9: .*: start it, or <self> remove yea://127\\.0\\.0\\.1:9',
      ),
    );
    expect(d.status).toBe(0);
  });

  it("a service that never answers HELLO is a warning, and doesn't keep doctor waiting", async () => {
    const u = await installed(fake());
    const svc = join(SCRATCH, `silent-svc-${Date.now()}.mjs`);
    const pid = `${svc}.pid`;

    // It never reads, ignores SIGTERM, and lets go of doctor's stderr, which the test waits on.
    writeFileSync(
      svc,
      `import { closeSync, writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
closeSync(2);
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
    );
    writeFileSync(
      join(u.home, '.yea', 'services.json'),
      JSON.stringify([`stdio:${process.execPath} ${svc} ${pid}`]),
    );

    const t0 = Date.now();
    const d = await yea(u, ['doctor']);

    process.kill(Number(readFileSync(pid, 'utf8')), 'SIGKILL');
    expect(d.out).toMatch(
      /^! stdio:.*: no answer within 5 s\. the bridge starts without it/m,
    );
    expect(d.status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 20_000);

  it("YEA_PRINCIPAL_PUB naming a file that can't be trusted is a warning with the pin recipe", async () => {
    const u = await installed(fake());
    const pub = join(u.home, 'principal.pub');

    writeFileSync(pub, 'ed25519:x\n');

    const d = await yea(u, ['doctor'], { env: { YEA_PRINCIPAL_PUB: pub } });

    expect(d.out).toMatch(/^! YEA_PRINCIPAL_PUB: /m);
    expect(d.out).toContain('sudo tee /etc/yea/principal.pub');
    expect(d.status).toBe(0);
  });
});

describe.concurrent('yea doctor: starting what each tool would start', () => {
  it("an entry whose command can't start is ✗, with the command that fixes it, and exits 1", async () => {
    const u = await installed({
      command: join(SCRATCH, 'no-such-node'),
      args: [],
    });
    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(
      lineOf(
        "✗ Claude Code: the bridge didn't start: .*ENOENT.*: <self> install --target claude-code",
      ),
    );
    expect(d.status).toBe(1);
  });

  it('a desktop app with a bare "node" is ✗: it has no shell PATH to find it in', async () => {
    const u = user();
    const r = await yea(u, ['install', '--target', 'claude-desktop']);

    register(configFile(r.out, 'Claude Desktop'), {
      command: 'node',
      args: [FAKE],
    });

    const d = await yea(u, ['doctor'], { env: { PATH: '/usr/bin:/bin' } });

    expect(d.out).toMatch(
      lineOf(
        `✗ Claude Desktop starts "node" without your shell's PATH.*: <self> install --target claude-desktop`,
      ),
    );
    expect(d.status).toBe(1);
  });

  it("an unbuilt checkout's entry that doesn't start ends with its build command, quoted", async () => {
    const root = clone(
      "import '@yea-protocol/not-installed';\n",
      'none',
      'my clone',
    );
    const u = await installed(cloneEntry(root));
    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(
      lineOf(
        `✗ Claude Code: the bridge didn't start: .*: its checkout isn't built \\(ts/dist/cli\\.js is missing\\): cd ${literal(`'${root}'`)} && npm ci && npm run build`,
      ),
    );
    expect(d.status).toBe(1);
  });

  it("a built checkout's entry that doesn't start ends with yea install: a rebuild changes nothing", async () => {
    const root = clone('process.exit(1);\n', 'fresh');
    const u = await installed(cloneEntry(root));
    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(
      lineOf(
        "✗ Claude Code: the bridge didn't start: it exited \\(1\\) before answering: <self> install --target claude-code",
      ),
    );
    expect(d.out).not.toContain('npm run build');
    expect(d.status).toBe(1);
  });

  it('a checkout entry that starts an old build is ✓, then a warning to rebuild it', async () => {
    const root = clone(readFileSync(FAKE, 'utf8'), 'stale');
    const u = await installed(cloneEntry(root));
    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(/^✓ Claude Code starts the bridge/m);
    expect(d.out).toMatch(
      lineOf(
        `! Claude Code starts an old build \\(ts/dist/cli\\.js is older than ts/src\\): cd ${literal(root)} && npm run build`,
      ),
    );
    expect(d.status).toBe(0);
  });

  it("a checkout entry whose node is gone ends with yea install: rebuilding wouldn't help", async () => {
    const u = await installed();
    const file = join(u.home, '.claude.json');
    const entry = JSON.parse(readFileSync(file, 'utf8')).mcpServers.yea;

    register(file, { ...entry, command: join(SCRATCH, 'v0.0.0', 'node') });

    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(
      lineOf(
        "✗ Claude Code: the bridge didn't start: .*ENOENT: <self> install --target claude-code",
      ),
    );
    expect(d.status).toBe(1);
  });

  it("Codex's entry that can't be read is ✗, with the install that replaces it", async () => {
    const u = await installed(fake());

    mkdirSync(join(u.home, '.codex'));
    writeFileSync(
      join(u.home, '.codex', 'config.toml'),
      "[mcp_servers.yea]\ncommand = 'npx'\n",
    );

    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(
      lineOf(
        `✗ Codex CLI: can't read its "yea" entry: .*: <self> install --target codex`,
      ),
    );
    expect(d.status).toBe(1);
  });

  it("a config that isn't JSON is ✗, without an install that would fail on it too", async () => {
    const u = await installed();

    writeFileSync(join(u.home, '.claude.json'), '{ not json');

    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(
      /^✗ Claude Code: can't read its "yea" entry: .* isn't valid JSON; fix it or add the server by hand$/m,
    );
    expect(d.status).toBe(1);
  });

  it("a project file's entry that can't be read is a warning: it's the project's to fix", async () => {
    const u = await installed(fake());
    const project = mkdtempSync(join(SCRATCH, 'project-'));

    register(join(project, '.vscode', 'mcp.json'), 'not an object', 'servers');

    const d = await yea(u, ['doctor'], { cwd: project });

    expect(d.out).toMatch(
      /^! VS Code: can't read the "yea" entry in its project file, which is the project's to fix: it has no command$/m,
    );
    expect(d.out).not.toContain('yea install --target vscode');
    expect(d.status).toBe(0);
  });

  it('starts each distinct command once, however many tools share it', async () => {
    const log = join(SCRATCH, `starts-${Date.now()}.log`);
    const u = await installed(fake('ok', log));

    register(join(u.home, '.gemini', 'settings.json'), fake('ok', log));

    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(/^✓ Claude Code starts the bridge/m);
    expect(d.out).toMatch(/^✓ Gemini CLI starts the bridge/m);
    expect(readFileSync(log, 'utf8')).toBe('start\n');
  });

  it('not registered with any tool is ✗', async () => {
    const u = user();

    await yea(u, ['init']);

    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(
      lineOf('✗ not registered with any AI tool: <self> install.*'),
    );
    expect(d.status).toBe(1);
  });
});

describe.concurrent('the handshake', () => {
  const env = process.env;

  it('answers', async () => {
    expect(await handshake(fake(), env)).toMatchObject({ kind: 'started' });
  });

  it("can't run its command at all", async () => {
    expect(
      await handshake({ command: join(SCRATCH, 'missing'), args: [] }, env),
    ).toMatchObject({
      kind: 'unrunnable',
      why: expect.stringContaining('ENOENT'),
    });
  });

  it('exits before answering', async () => {
    expect(await handshake(fake('exit'), env)).toMatchObject({
      kind: 'failed',
      why: expect.stringContaining('exited'),
    });
  });

  it('answers with an error', async () => {
    expect(await handshake(fake('error'), env)).toMatchObject({
      kind: 'failed',
      why: expect.stringContaining('no thanks'),
    });
  });

  it('takes too long', async () => {
    expect(await handshake(fake('silent'), env, 300)).toMatchObject({
      kind: 'slow',
    });
  });
});

describe('what doctor says about a launch', () => {
  const at = { id: 'cursor', name: 'Cursor', path: null, project: false };

  it('no answer in time is a warning, not a failure: first runs download the bridge', () => {
    expect(
      launchLine(
        { ...at, bridge: PORTABLE_BRIDGE },
        { kind: 'slow', ms: 60_000 },
      ),
    ).toEqual([
      '!',
      'Cursor: no answer within 60 s (first runs download the bridge): run yea doctor again',
    ]);
  });

  it("a slow entry that doesn't download anything points at its services instead", () => {
    const [mark, text] = launchLine(
      { ...at, bridge: { command: process.execPath, args: [BIN, 'mcp'] } },
      { kind: 'slow', ms: 60_000 },
    );

    expect(mark).toBe('!');
    expect(text).not.toContain('download');
    expect(text).toMatch(
      /a service it connects to may not be answering: .* services$/,
    );
  });

  it('an npx entry for a package npm has no copy of says so, and points at a checkout', () => {
    const [mark, text] = launchLine(
      { ...at, bridge: PORTABLE_BRIDGE },
      {
        kind: 'failed',
        why: 'npm error code E404',
        stderr:
          'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@yea-protocol%2fcli\n',
      },
    );

    expect(mark).toBe('✗');
    expect(text).toContain("@yea-protocol/cli isn't on npm yet");
    expect(text).toMatch(
      /npm ci && npm run build && node cli\/bin\/yea\.js install$/,
    );
  });
});

describe('how install and doctor name yea', () => {
  it('as yea, run from the published package', () => {
    expect(
      self(
        'doctor',
        '/usr/local/lib/node_modules/@yea-protocol/cli/bin/yea.js',
      ),
    ).toBe('yea doctor');
  });

  it("as node and the clone's bin, quoted, run from a clone", () => {
    const root = clone('', 'fresh', "it's mine");

    expect(self('doctor', join(root, 'cli', 'bin', 'yea.js'))).toBe(
      `node '${root.replaceAll("'", "'\\''")}/cli/bin/yea.js' doctor`,
    );
  });

  it('in every command it suggests that runs here, from this checkout', async () => {
    const u = user();
    const r = await yea(u, ['install', '--target', 'claude-code']);
    const d = await yea(u, ['doctor']);
    const agent = await agentOf(u);
    const shown = (out: string) =>
      out
        .replaceAll(shellWord(process.execPath), '<node>')
        .replaceAll(SELF, '<self>')
        .replaceAll(shellWord(BIN), '<bin>')
        .replaceAll(u.home, '<home>')
        .replaceAll(agent, '<agent>')
        .replaceAll(agent.slice(0, 24), '<agent>')
        .replace(/node \d+\.\d+\.\d+/, 'node <version>')
        .replace(/\(\d+ ms\)/, '(<n> ms)');

    expect(shown(r.out)).toMatchInlineSnapshot(`
      "agent key   <agent> (<home>/.yea)
      principal   not on this machine (recommended). On the device that holds it, run:
                    yea grant --to <agent> --risk low --each spend=25.00USD --total spend=100.00USD --exp 30d
                  and save the token here with: <self> grant-import <token>   (or re-run with --with-principal to try things quickly)
      bridge      <node> <bin> mcp (this checkout)
      ✓ Claude Code: MCP server "yea" → <home>/.claude.json
      ✓ Claude Code: agent instructions → <home>/.claude/CLAUDE.md

      next: add a service with \`<self> add <url>\`, or try the examples: \`<self> examples\`, then \`<self> add yea://127.0.0.1:7447\`
      restart your AI tool, then ask it to do something. Check anything with: <self> doctor
      "
    `);
    expect(shown(d.out)).toMatchInlineSnapshot(`
      "✓ node <version>
      ✓ agent key <agent>…
      ✓ principal key is not on this machine (recommended)
      ! no grants: your agent can read but not act. Issue one where your principal key is, and import it here:
          yea grant --to <agent> …   (there)
          <self> grant-import <token>   (here)
        or, to try things on one machine: <self> install --with-principal
      ! no services: <self> add <url>
      ✓ Claude Code starts the bridge (<n> ms): <node> <bin> mcp
      "
    `);
  });
});
