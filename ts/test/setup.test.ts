import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guiPath, PORTABLE_BRIDGE } from '../src/setup/bridge-command.js';
import {
  type BridgeCommand,
  bridgeFor,
  CLIENTS,
  isPortableBridge,
  runningBridge,
} from '../src/setup.js';

describe('yea install/uninstall targets', () => {
  it('install then uninstall leaves existing config exactly as it was', () => {
    const home = mkdtempSync(join(tmpdir(), 'yea-home-'));
    const prev = process.env.HOME;

    process.env.HOME = home;

    try {
      mkdirSync(join(home, '.claude'));
      mkdirSync(join(home, '.codex'));

      const claudeJson = `${JSON.stringify(
        { numStartups: 3, mcpServers: { other: { command: 'x' } } },
        null,
        2,
      )}\n`;

      writeFileSync(join(home, '.claude.json'), claudeJson);
      writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# my notes\n');
      writeFileSync(
        join(home, '.codex', 'config.toml'),
        '[model]\nname = "x"\n',
      );

      const scope = { local: false, cwd: home };

      for (const t of ['claude-code', 'codex', 'cursor', 'gemini']) {
        CLIENTS[t].install(scope, PORTABLE_BRIDGE);
      }

      const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));

      expect(cfg.mcpServers.yea).toMatchObject({
        type: 'stdio',
        alwaysLoad: true,
        command: 'npx',
      });
      expect(cfg.mcpServers.other).toEqual({ command: 'x' });
      expect(
        readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'),
      ).toContain('Never split or restructure a purchase');
      expect(CLIENTS['claude-code'].registered(scope)).toEqual(PORTABLE_BRIDGE);
      // idempotent
      CLIENTS['claude-code'].install(scope, PORTABLE_BRIDGE);
      expect(
        readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8').match(
          /YEA_START/g,
        ),
      ).toHaveLength(1);

      for (const t of ['claude-code', 'codex', 'cursor', 'gemini']) {
        CLIENTS[t].uninstall(scope);
      }

      expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(
        claudeJson.replace('"x"\n    }\n  }', '"x"\n    }\n  }'),
      );
      expect(
        JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')),
      ).toEqual(JSON.parse(claudeJson));
      expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe(
        '# my notes\n',
      );
      expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(
        '[model]\nname = "x"\n',
      );
      expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(true);
      expect(CLIENTS.cursor.registered(scope)).toBeNull();
    } finally {
      process.env.HOME = prev;
    }
  });
});

/** A new temp folder, by its real path (macOS's tmpdir is behind a symlink). */
const temp = (prefix: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** Write `files` (path → text) under `root`, making folders as needed. */
function put(root: string, files: Record<string, string>) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
}

/** Set the modification time of `file` to `seconds` ago. */
function age(file: string, seconds: number) {
  const t = Date.now() / 1000 - seconds;

  utimesSync(file, t, t);
}

const SOURCES = ['ts/src/cli.ts', 'mcp/src/bridge.ts'];
const BUILDS = ['ts/dist/cli.js', 'mcp/dist/bridge.js'];

/** A yea clone in a temp folder, built after its last source change. */
function checkout(): string {
  const root = temp('yea-checkout-');

  put(root, {
    'package.json': '{"name":"yea-monorepo"}',
    'cli/bin/yea.js': '',
  });

  for (const f of SOURCES) {
    put(root, { [f]: '' });
    age(join(root, f), 100);
  }

  for (const f of BUILDS) {
    put(root, { [f]: '' });
    age(join(root, f), 10);
  }

  return root;
}

/** A folder holding a node and (unless `npx` is false) the npx beside it, as node's installers lay them out. */
function nodeDir(npx = true): string {
  const dir = temp('yea-node-');

  put(dir, { node: '', ...(npx ? { npx: '' } : {}) });

  return dir;
}

describe('the bridge command yea install registers', () => {
  it("from a checkout: this node, absolute, and the checkout's bin", () => {
    const root = checkout();
    const node = join(nodeDir(), 'node');
    const want = {
      bridge: { command: node, args: [join(root, 'cli/bin/yea.js'), 'mcp'] },
      checkout: root,
    };

    expect(runningBridge(join(root, 'cli/bin/yea.js'), node)).toEqual(want);
    // `node ts/dist/cli.js install` from the clone registers the same bin.
    expect(runningBridge(join(root, 'ts/dist/cli.js'), node)).toEqual(want);
  });

  it('from a checkout reached through a link (npm link): the checkout', () => {
    const root = checkout();
    const bin = join(temp('yea-prefix-'), 'yea');

    symlinkSync(join(root, 'cli/bin/yea.js'), bin);

    expect(runningBridge(bin, 'node').checkout).toBe(root);
  });

  it.each(BUILDS)('refuses a checkout without %s', (build) => {
    const root = checkout();

    rmSync(join(root, build));

    expect(() => runningBridge(join(root, 'cli/bin/yea.js'), 'node')).toThrow(
      /run `npm run build` first/,
    );
  });

  it.each(SOURCES)(
    'refuses a checkout whose build is older than %s',
    (source) => {
      const root = checkout();

      age(join(root, source), 1);

      expect(() => runningBridge(join(root, 'cli/bin/yea.js'), 'node')).toThrow(
        /run `npm run build` first/,
      );
    },
  );

  it('keeps the npx entry from the npx cache, with the npx beside this node', () => {
    const cache = temp('yea-npm-');
    const bin = '_npx/0123abcd/node_modules/@yea-protocol/cli/bin/yea.js';
    const dir = nodeDir();

    put(cache, { [bin]: '' });

    expect(runningBridge(join(cache, bin), join(dir, 'node'))).toEqual({
      bridge: { command: join(dir, 'npx'), args: PORTABLE_BRIDGE.args },
      checkout: null,
    });
  });

  it('keeps the npx entry from a global install', () => {
    const prefix = temp('yea-global-');
    const pkg = 'lib/node_modules/@yea-protocol/cli';
    const dir = nodeDir();

    put(prefix, {
      [`${pkg}/bin/yea.js`]: '',
      [`${pkg}/package.json`]: '{"name":"@yea-protocol/cli"}',
    });
    mkdirSync(join(prefix, 'bin'));
    symlinkSync(join(prefix, pkg, 'bin/yea.js'), join(prefix, 'bin/yea'));

    expect(runningBridge(join(prefix, 'bin/yea'), join(dir, 'node'))).toEqual({
      bridge: { command: join(dir, 'npx'), args: PORTABLE_BRIDGE.args },
      checkout: null,
    });
  });

  it('without an npx beside this node, takes the first on the PATH, as an absolute path', () => {
    const cache = temp('yea-npm-');
    const bin = '_npx/0123abcd/node_modules/@yea-protocol/cli/bin/yea.js';
    const onPath = nodeDir();
    const path = ['relative/bin', temp('yea-empty-'), onPath].join(delimiter);

    put(cache, { [bin]: '' });

    expect(
      runningBridge(join(cache, bin), join(nodeDir(false), 'node'), path).bridge
        .command,
    ).toBe(join(onPath, 'npx'));
  });

  it('without any npx, refuses, rather than writing one no tool can start', () => {
    const cache = temp('yea-npm-');
    const bin = '_npx/0123abcd/node_modules/@yea-protocol/cli/bin/yea.js';

    put(cache, { [bin]: '' });

    expect(() =>
      runningBridge(join(cache, bin), join(nodeDir(false), 'node'), ''),
    ).toThrow(/no npx beside .* or on your PATH: install npm/);
  });

  it("isn't fooled by another monorepo with the same layout", () => {
    const root = checkout();

    writeFileSync(join(root, 'package.json'), '{"name":"not-yea"}');

    expect(runningBridge(join(root, 'cli/bin/yea.js'), 'node').checkout).toBe(
      null,
    );
  });
});

describe('the bridge command each tool gets (bridgeFor)', () => {
  const running: BridgeCommand = {
    command: '/opt/node/bin/node',
    args: ['/src/yea/cli/bin/yea.js', 'mcp'],
  };

  it('a project file gets the portable npx entry: no personal paths', () => {
    for (const gui of [false, true]) {
      expect(bridgeFor({ project: true, gui }, running)).toEqual(
        PORTABLE_BRIDGE,
      );
    }
  });

  it("a terminal tool's own config gets the running command as is", () => {
    expect(bridgeFor({ project: false, gui: false }, running)).toEqual(running);
  });

  it.skipIf(guiPath() === null)(
    "a desktop app's own config also gets a PATH with this node's folder first",
    () => {
      expect(
        bridgeFor({ project: false, gui: true }, running, '/opt/node/bin/node'),
      ).toEqual({
        ...running,
        env: { PATH: `/opt/node/bin${delimiter}${guiPath()}` },
      });
    },
  );
});

describe("whether an entry is yea's portable one (isPortableBridge)", () => {
  it('is exactly the published package through a bare npx, with no env', () => {
    expect(isPortableBridge(PORTABLE_BRIDGE)).toBe(true);
    expect(
      isPortableBridge({ ...PORTABLE_BRIDGE, command: '/usr/local/bin/npx' }),
    ).toBe(false);
    expect(
      isPortableBridge({ ...PORTABLE_BRIDGE, args: ['-y', 'other', 'mcp'] }),
    ).toBe(false);
    expect(isPortableBridge({ ...PORTABLE_BRIDGE, env: { A: 'b' } })).toBe(
      false,
    );
  });
});

describe('reading a registered entry back', () => {
  let home: string;
  let prev: string | undefined;
  const scope = () => ({ local: false, cwd: home });
  const checkoutBridge: BridgeCommand = {
    command: '/opt/node/bin/node',
    args: ['/src/my yea/cli/bin/yea.js', 'mcp'],
    env: { PATH: '/opt/node/bin:/usr/bin:/bin' },
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'yea-home-'));
    prev = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = prev;
  });

  it('a JSON config gives back what was written, env included', () => {
    CLIENTS['claude-code'].install(scope(), checkoutBridge);

    expect(CLIENTS['claude-code'].registered(scope())).toEqual(checkoutBridge);
  });

  it('a JSON entry without a command is unreadable', () => {
    put(home, {
      '.claude.json': JSON.stringify({ mcpServers: { yea: { args: [] } } }),
    });

    expect(() => CLIENTS['claude-code'].registered(scope())).toThrow(/command/);
  });

  it('Codex: installing again replaces the entry, and leaves the rest of config.toml', () => {
    const toml = join(home, '.codex', 'config.toml');

    put(home, {
      '.codex/config.toml': '[model]\nname = "x"\n\n[tui]\na = 1\n',
    });
    CLIENTS.codex.install(scope(), PORTABLE_BRIDGE);
    CLIENTS.codex.install(scope(), checkoutBridge);

    const text = readFileSync(toml, 'utf8');

    expect(text.match(/\[mcp_servers\.yea\]/g)).toHaveLength(1);
    expect(text).toContain('[model]\nname = "x"\n');
    expect(text).toContain('[tui]\na = 1\n');
    expect(CLIENTS.codex.registered(scope())).toEqual(checkoutBridge);
  });

  it("Codex: an entry it can't read is unreadable, and installing again fixes it", () => {
    put(home, {
      '.codex/config.toml': "[mcp_servers.yea]\ncommand = 'npx'\n",
    });

    expect(() => CLIENTS.codex.registered(scope())).toThrow(/can't read/);

    CLIENTS.codex.install(scope(), PORTABLE_BRIDGE);

    expect(CLIENTS.codex.registered(scope())).toEqual(PORTABLE_BRIDGE);
  });
});
