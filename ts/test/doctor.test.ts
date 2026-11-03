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
import { PORTABLE_BRIDGE } from '../src/setup.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(
  /[\\/]$/,
  '',
);
const BIN = join(REPO, 'cli', 'bin', 'yea.js');
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
function register(file: string, entry: object, key = 'mcpServers') {
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
    expect(r.err).toContain('run `npm run build` first');
    expect(existsSync(join(u.home, '.claude.json'))).toBe(false);
    expect(existsSync(join(u.home, '.yea', 'agent.key'))).toBe(false);
  });
});

describe.concurrent('yea doctor: grants', () => {
  it('"no grants" is a warning naming both ways to get one, and doctor still exits 0', async () => {
    const u = await installed();
    const agent = await agentOf(u);
    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(/^! no grants: your agent can read but not act/m);
    expect(d.out).toContain(`yea grant --to ${agent}`);
    expect(d.out).toContain('yea grant-import <token>');
    expect(d.out).toContain('yea install --with-principal');
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

    const d = await yea(u, ['doctor']);

    expect(d.out).not.toContain('no grants');
    expect(d.out).toMatch(/^✓ grant /m);
    expect(d.status).toBe(0);
  });

  it('the principal-elsewhere way works: yea grant --to there, yea grant-import here', async () => {
    const u = await installed();
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
    const u = await installed();
    const other = user();

    await yea(other, ['init']);

    const g = await yea(other, ['grant', '--risk', 'low']);

    mkdirSync(join(u.home, '.yea', 'grants'), { recursive: true });
    writeFileSync(join(u.home, '.yea', 'grants', 'other.pg'), g.out);

    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(
      /^! grant \w+ is held by another key.*where your principal key is/m,
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

    expect(d.out).toMatch(/^! yea:\/\/127\.0\.0\.1:9: .*yea remove/m);
    expect(d.status).toBe(0);
  });

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
      /^✗ Claude Code: the bridge didn't start: .*ENOENT.*: yea install --target claude-code$/m,
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
      /^✗ Claude Desktop starts "node" without your shell's PATH.*: yea install --target claude-desktop$/m,
    );
    expect(d.status).toBe(1);
  });

  it("a checkout entry that doesn't start ends with the checkout's build command", async () => {
    const root = mkdtempSync(join(SCRATCH, 'clone-'));

    mkdirSync(join(root, 'ts', 'src'), { recursive: true });
    mkdirSync(join(root, 'cli', 'bin'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"yea-monorepo"}');
    writeFileSync(
      join(root, 'cli', 'bin', 'yea.js'),
      "import '@yea-protocol/not-installed';\n",
    );

    const u = await installed({
      command: process.execPath,
      args: [join(root, 'cli', 'bin', 'yea.js'), 'mcp'],
    });
    const d = await yea(u, ['doctor']);

    expect(d.out).toMatch(
      new RegExp(
        `^✗ Claude Code: the bridge didn't start: .*: cd ${root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} && npm ci && npm run build$`,
        'm',
      ),
    );
    expect(d.status).toBe(1);
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

    expect(d.out).toMatch(/^✗ not registered with any AI tool: yea install/m);
    expect(d.status).toBe(1);
  });
});

describe.concurrent('the handshake', () => {
  const env = process.env;

  it('answers', async () => {
    expect(await handshake(fake(), env)).toMatchObject({ kind: 'started' });
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
