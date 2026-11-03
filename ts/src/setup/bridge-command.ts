/**
 * The command an AI tool runs to start the YEA MCP bridge: the yea that ran `yea install` (a
 * checkout's bin, or the published package through npx), adapted to where it's written.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { platform } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { realPath } from '../fs-util.js';
import { isObject, isStringList, isStringRecord } from '../util.js';

/** How an MCP config starts the bridge. */
export interface BridgeCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The yea that's running: its bridge command, and the checkout it runs from, if any. */
export interface RunningBridge {
  bridge: BridgeCommand;
  checkout: string | null;
}

/** Where a tool's config is: a project file (may be committed) or not, and in a desktop app or not. */
export interface Placement {
  project: boolean;
  gui: boolean;
}

/** A "yea" entry that isn't a bridge command: unlike a config file that can't be read, `yea install` replaces it. */
export class BadEntry extends Error {}

/** The published package through whichever npx is on the PATH: the entry anyone can share. */
export const PORTABLE_BRIDGE: BridgeCommand = {
  command: 'npx',
  args: ['-y', '@yea-protocol/cli', 'mcp'],
};

/** What `npm run build` makes in a checkout, each beside the sources it's built from. */
const BUILDS = [
  { built: 'ts/dist/cli.js', from: 'ts/src' },
  { built: 'mcp/dist/bridge.js', from: 'mcp/src' },
];

/**
 * The PATH a desktop app starts commands with when it's opened from the Dock or a launcher
 * rather than a shell, so without nvm's or Homebrew's node; null on Windows, where apps get the
 * same PATH as the shell.
 */
export function guiPath(os = platform()): string | null {
  if (os === 'win32') {
    return null;
  }

  return os === 'darwin'
    ? '/usr/bin:/bin:/usr/sbin:/sbin'
    : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
}

/**
 * The root of the yea checkout `script` is in (`cli/bin/yea.js` or `ts/dist/cli.js`, through any
 * link), or null if it's anywhere else, such as the npx cache or a global install.
 */
export function checkoutRoot(script: string): string | null {
  const real = realPath(script);

  if (!real) {
    return null;
  }

  const root = resolve(dirname(real), '..', '..');

  return existsSync(join(root, 'ts', 'src')) && isMonorepo(root) ? root : null;
}

/** Whether `root/package.json` is yea's monorepo. */
function isMonorepo(root: string): boolean {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );

    return isObject(pkg) && pkg.name === 'yea-monorepo';
  } catch {
    return false;
  }
}

/**
 * The newest modification time of any file under `dir`, or 0 if it has none. A link counts as
 * itself, so one that leads nowhere is no error.
 */
function newest(dir: string): number {
  let latest = 0;

  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);

    latest = Math.max(
      latest,
      e.isDirectory() ? newest(path) : lstatSync(path).mtimeMs,
    );
  }

  return latest;
}

/** Why the checkout at `root` can't serve the bridge as it is: a build missing or older than its source. */
export function unbuilt(root: string): string | null {
  for (const { built, from } of BUILDS) {
    const file = join(root, built);

    const src = join(root, from);

    if (!existsSync(file)) {
      return `${built} is missing`;
    }

    if (existsSync(src) && statSync(file).mtimeMs < newest(src)) {
      return `${built} is older than ${from}`;
    }
  }

  return null;
}

/**
 * The npx to start the published package with: the one beside `node`, as node's installers put
 * it, else the first on `path`. On Windows, the bare `npx`: there it's a .cmd, which starts only
 * through a shell, and apps get the shell's PATH. Throws if there's none.
 */
function npxFor(node: string, path: string): string {
  if (platform() === 'win32') {
    return 'npx';
  }

  const npx = [dirname(node), ...path.split(delimiter).filter(isAbsolute)]
    .map((dir) => join(dir, 'npx'))
    .find((f) => existsSync(f));

  if (!npx) {
    throw new Error(
      `there's no npx beside ${node} or on your PATH: install npm, which comes with node from nodejs.org`,
    );
  }

  return npx;
}

/**
 * The bridge command of the yea running as `node script`: this node and the checkout's bin, or
 * the published package through the npx beside this node (or on `path`). Both absolute, since an
 * app may not start them from a shell. Throws if the checkout isn't built, or there's no npx.
 */
export function runningBridge(
  script = process.argv[1] ?? '',
  node = process.execPath,
  path = process.env.PATH ?? '',
): RunningBridge {
  const root = checkoutRoot(script);

  if (!root) {
    return {
      bridge: { command: npxFor(node, path), args: PORTABLE_BRIDGE.args },
      checkout: null,
    };
  }

  const why = unbuilt(root);

  if (why) {
    throw new Error(
      `this checkout isn't built (${why}). Build it first: cd ${shellWord(root)} && npm run build`,
    );
  }

  return {
    bridge: {
      command: node,
      args: [join(root, 'cli', 'bin', 'yea.js'), 'mcp'],
    },
    checkout: root,
  };
}

/**
 * The PATH a tool whose config is at `p` starts the bridge with, when it isn't your shell's: a
 * desktop app's own config. A project file holds the portable bare `npx`, which needs your
 * shell's PATH; Cursor and VS Code, the desktop apps that read project files, start servers with
 * it when they can get it from your shell.
 */
export function launchPath(p: Placement): string | null {
  return p.gui && !p.project ? guiPath() : null;
}

/**
 * The bridge command a tool gets, from the running one: the one place an entry is built. A
 * project file gets the portable entry, so no personal path is committed. A desktop app's own
 * config also gets a PATH with this node's folder first: npx and the bridge's `#!/usr/bin/env
 * node` scripts need node there, and such an app doesn't start them from a shell.
 *
 * That PATH replaces the app's, and a config can't add to the PATH it inherits. So a desktop app
 * that does read your shell's PATH (Cursor) no longer passes it on, and a `stdio:` service
 * needing more than node, such as `uv` or Homebrew's `python3`, needs an absolute path.
 */
export function bridgeFor(
  p: Placement,
  running: BridgeCommand,
  node = process.execPath,
): BridgeCommand {
  if (p.project) {
    return PORTABLE_BRIDGE;
  }

  const path = launchPath(p);

  if (!path) {
    return running;
  }

  return {
    ...running,
    env: { ...running.env, PATH: `${dirname(node)}${delimiter}${path}` },
  };
}

/** `a` as one word of a POSIX shell command: as it is when that's safe, else single-quoted. */
export const shellWord = (a: string) =>
  /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`;

/** `b` as a command line, for people to read and to paste. */
export function describeBridge(b: BridgeCommand): string {
  return [b.command, ...b.args].map(shellWord).join(' ');
}

/** Whether `b` is yea's portable entry, as `yea install` writes it in a project file. */
export const isPortableBridge = (b: BridgeCommand) =>
  b.command === PORTABLE_BRIDGE.command &&
  b.args.length === PORTABLE_BRIDGE.args.length &&
  b.args.every((a, i) => a === PORTABLE_BRIDGE.args[i]) &&
  !Object.keys(b.env ?? {}).length;

/** A config's "yea" entry as a bridge command; throws a BadEntry saying what's wrong with it. */
export function parseBridge(v: unknown): BridgeCommand {
  if (!isObject(v) || typeof v.command !== 'string') {
    throw new BadEntry('it has no command');
  }

  const args = v.args ?? [];

  if (!isStringList(args)) {
    throw new BadEntry('its args are not a list of strings');
  }

  if (v.env === undefined) {
    return { command: v.command, args };
  }

  if (!isStringRecord(v.env)) {
    throw new BadEntry('its env is not a table of strings');
  }

  return { command: v.command, args, env: v.env };
}
