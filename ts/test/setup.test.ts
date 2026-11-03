import {
  existsSync,
  lutimesSync,
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
import {
  BadEntry,
  guiPath,
  PORTABLE_BRIDGE,
  parseBridge,
  shellWord,
} from '../src/setup/bridge-command.js';
import {
  type BridgeCommand,
  bridgeFor,
  CLIENTS,
  expandInteraction,
  isPortableBridge,
  REQUIRE_INTERACTION_ENV,
  REQUIRE_INTERACTION_REFERENCE,
  REQUIRE_INTERACTION_VALUES,
  requiresInteraction,
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
      /Build it first: cd .* && npm run build$/,
    );
  });

  it.each(SOURCES)(
    'refuses a checkout whose build is older than %s',
    (source) => {
      const root = checkout();

      age(join(root, source), 1);

      expect(() => runningBridge(join(root, 'cli/bin/yea.js'), 'node')).toThrow(
        /Build it first: cd .* && npm run build$/,
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

  it('names the checkout in its refusal as a shell word: a folder with a space still works', () => {
    const root = join(temp('yea-spaced-'), 'my yea');

    put(root, {
      'package.json': '{"name":"yea-monorepo"}',
      'cli/bin/yea.js': '',
      'ts/src/cli.ts': '',
    });

    expect(() => runningBridge(join(root, 'cli/bin/yea.js'), 'node')).toThrow(
      `cd '${root}' && npm run build`,
    );
  });

  it('a link that leads nowhere in the source is no error', () => {
    const root = checkout();

    const link = join(root, 'ts/src/dangling.ts');
    const before = Date.now() / 1000 - 100;

    symlinkSync(join(root, 'nowhere'), link);
    lutimesSync(link, before, before);

    expect(runningBridge(join(root, 'cli/bin/yea.js'), 'node').checkout).toBe(
      root,
    );
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
        bridgeFor({ project: false, gui: true }, running, {
          node: '/opt/node/bin/node',
        }),
      ).toEqual({
        ...running,
        env: { PATH: `/opt/node/bin${delimiter}${guiPath()}` },
      });
    },
  );

  it('with requireInteraction, every entry also gets YEA_REQUIRE_INTERACTION=1, a project file too', () => {
    const on = { requireInteraction: true, node: '/opt/node/bin/node' };

    expect(REQUIRE_INTERACTION_ENV).toEqual({ YEA_REQUIRE_INTERACTION: '1' });

    for (const gui of [false, true]) {
      const project = bridgeFor({ project: true, gui }, running, on);

      expect(project).toEqual({
        ...PORTABLE_BRIDGE,
        env: REQUIRE_INTERACTION_ENV,
      });
      expect(isPortableBridge(project)).toBe(true);
    }

    expect(bridgeFor({ project: false, gui: false }, running, on)).toEqual({
      ...running,
      env: REQUIRE_INTERACTION_ENV,
    });

    const desktop = bridgeFor({ project: false, gui: true }, running, on);

    expect(desktop.env).toMatchObject(REQUIRE_INTERACTION_ENV);
    expect(Object.keys(desktop.env ?? {}).sort()).toEqual(
      guiPath() === null
        ? ['YEA_REQUIRE_INTERACTION']
        : ['PATH', 'YEA_REQUIRE_INTERACTION'],
    );
  });
});

describe('a command line to paste (shellWord)', () => {
  it('leaves a plain word as it is, and single-quotes anything else', () => {
    expect(shellWord('/opt/node/bin/node')).toBe('/opt/node/bin/node');
    expect(shellWord('-y')).toBe('-y');
    expect(shellWord('/src/my yea')).toBe("'/src/my yea'");
    expect(shellWord('$HOME/`x`')).toBe("'$HOME/`x`'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
    expect(shellWord('')).toBe("''");
  });
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

  it('allows YEA_REQUIRE_INTERACTION alone as its env, set to one of its values', () => {
    const env = (e: Record<string, string>) =>
      isPortableBridge({ ...PORTABLE_BRIDGE, env: e });

    for (const v of ['1', 'true', '0', 'false', '']) {
      expect(env({ YEA_REQUIRE_INTERACTION: v })).toBe(true);
    }

    expect(
      env({ YEA_REQUIRE_INTERACTION: REQUIRE_INTERACTION_REFERENCE }),
    ).toBe(true);
    expect(env({ YEA_REQUIRE_INTERACTION: 'yes' })).toBe(false);
    expect(env({ YEA_REQUIRE_INTERACTION: '1', A: 'b' })).toBe(false);
  });
});

describe("the Claude Code plugin's entry", () => {
  it('is the portable one, and passes on YEA_REQUIRE_INTERACTION with an empty default', () => {
    const file = new URL('../../plugins/yea/.mcp.json', import.meta.url);
    const entry = parseBridge(
      JSON.parse(readFileSync(file, 'utf8')).mcpServers.yea,
    );

    // Without `:-`, an unset variable would reach the bridge as the literal `${…}`, which it refuses.
    expect(REQUIRE_INTERACTION_REFERENCE).toBe(
      ['$', '{YEA_REQUIRE_INTERACTION:-}'].join(''),
    );
    expect(entry).toEqual({
      ...PORTABLE_BRIDGE,
      env: { YEA_REQUIRE_INTERACTION: REQUIRE_INTERACTION_REFERENCE },
    });
    expect(isPortableBridge(entry)).toBe(true);
  });
});

describe("the plugin's reference, expanded as Claude Code does (expandInteraction)", () => {
  it("is the environment's value, empty when unset; any other value is as it is", () => {
    const ref = REQUIRE_INTERACTION_REFERENCE;

    expect(expandInteraction(ref, {})).toBe('');
    expect(expandInteraction(ref, { YEA_REQUIRE_INTERACTION: '1' })).toBe('1');
    expect(expandInteraction(ref, { YEA_REQUIRE_INTERACTION: 'yes' })).toBe(
      'yes',
    );
    expect(expandInteraction('0', { YEA_REQUIRE_INTERACTION: '1' })).toBe('0');
    expect(expandInteraction(undefined, { YEA_REQUIRE_INTERACTION: '1' })).toBe(
      undefined,
    );
    expect(requiresInteraction(expandInteraction(ref, {}))).toBe(false);
  });
});

describe("YEA_REQUIRE_INTERACTION's values (requiresInteraction)", () => {
  it('reads 1 and true as on; 0, false, empty and unset as off; anything else as none', () => {
    expect(['1', 'true'].map(requiresInteraction)).toEqual([true, true]);
    expect(['0', 'false', '', undefined].map(requiresInteraction)).toEqual([
      false,
      false,
      false,
      false,
    ]);

    // The last: a `${…}` reference with no default that Claude Code left unexpanded.
    const unexpanded = ['$', '{YEA_REQUIRE_INTERACTION}'].join('');

    expect(['yes', 'TRUE', ' 1', unexpanded].map(requiresInteraction)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(REQUIRE_INTERACTION_VALUES).toEqual({
      '1': true,
      true: true,
      '0': false,
      false: false,
      '': false,
    });
  });
});

/**
 * The tables `toml` declares, in order, each name without its quotes and spaces. TOML forbids
 * declaring one twice, so a name repeated here is a file Codex can't load.
 */
function tomlTables(toml: string): string[] {
  return toml.split('\n').flatMap((line) => {
    const m = /^\s*\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);

    return m
      ? [
          m[1]
            .split('.')
            .map((k) => k.trim().replace(/^(["'])(.*)\1$/, '$2'))
            .join('.'),
        ]
      : [];
  });
}

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

  it.each([
    ['spaced', '[ mcp_servers . yea ]'],
    ['commented', '[mcp_servers.yea]  # added by hand'],
    ['quoted', '[mcp_servers."yea"]'],
  ])(
    'Codex: a %s header is the same table, and installing replaces it',
    (_, header) => {
      const toml = join(home, '.codex', 'config.toml');

      put(home, {
        '.codex/config.toml': `[model]\nname = "x"\n\n${header}\ncommand = "npx"\nargs = ["-y", "@yea-protocol/cli", "mcp"]\n\n[tui]\na = 1\n`,
      });

      expect(CLIENTS.codex.registered(scope())).toEqual(PORTABLE_BRIDGE);

      CLIENTS.codex.install(scope(), checkoutBridge);

      const text = readFileSync(toml, 'utf8');

      expect(tomlTables(text)).toEqual(['model', 'tui', 'mcp_servers.yea']);
      expect(CLIENTS.codex.registered(scope())).toEqual(checkoutBridge);
    },
  );

  it("Codex: installing drops the old entry's sub-tables, such as its env", () => {
    const toml = join(home, '.codex', 'config.toml');

    put(home, {
      '.codex/config.toml':
        '[mcp_servers.yea]\ncommand = "npx"\n\n[mcp_servers.yea.env]\nFOO = "bar"\n\n[tui]\na = 1\n',
    });
    CLIENTS.codex.install(scope(), PORTABLE_BRIDGE);

    const text = readFileSync(toml, 'utf8');

    expect(tomlTables(text)).toEqual(['tui', 'mcp_servers.yea']);
    expect(text).not.toContain('FOO');
  });

  it("Codex: an env sub-table is read back as the entry's env, which doctor starts it with", () => {
    put(home, {
      '.codex/config.toml':
        '[mcp_servers.yea]\ncommand = "npx"\n\n[ mcp_servers.yea.env ]  # by hand\nFOO = "bar"\n"A B" = "c"\n\n[tui]\na = 1\n',
    });

    expect(CLIENTS.codex.registered(scope())).toEqual({
      command: 'npx',
      args: [],
      env: { FOO: 'bar', 'A B': 'c' },
    });
  });

  it('Codex: an env set both inline and as a sub-table is unreadable, which installing replaces', () => {
    put(home, {
      '.codex/config.toml':
        '[mcp_servers.yea]\ncommand = "npx"\nenv = { "A" = "b" }\n\n[mcp_servers.yea.env]\nFOO = "bar"\n',
    });

    expect(() => CLIENTS.codex.registered(scope())).toThrow(BadEntry);
  });

  it('Codex: sub-tables without the table are an entry with no command, which installing replaces', () => {
    put(home, { '.codex/config.toml': '[mcp_servers.yea.env]\nFOO = "bar"\n' });

    expect(() => CLIENTS.codex.registered(scope())).toThrow(BadEntry);

    CLIENTS.codex.install(scope(), PORTABLE_BRIDGE);

    expect(CLIENTS.codex.registered(scope())).toEqual(PORTABLE_BRIDGE);
  });

  it.each([
    ['a key of [mcp_servers]', '[mcp_servers]\nyea = { command = "npx" }\n'],
    ['a dotted key', 'mcp_servers.yea.command = "npx"\n'],
    ['an array of tables', '[[mcp_servers.yea]]\ncommand = "npx"\n'],
  ])(
    "Codex: the server defined as %s isn't read or written over",
    (_, defined) => {
      const toml = join(home, '.codex', 'config.toml');

      put(home, { '.codex/config.toml': defined });

      const read = () => CLIENTS.codex.registered(scope());

      expect(read).toThrow(/in a way yea can't replace/);
      expect(read).not.toThrow(BadEntry);
      expect(() => CLIENTS.codex.install(scope(), PORTABLE_BRIDGE)).toThrow(
        /in a way yea can't replace/,
      );
      expect(readFileSync(toml, 'utf8')).toBe(defined);
    },
  );
});
