/**
 * The command an AI tool runs to start the YEA MCP bridge: the yea that ran `yea install` (a
 * checkout's bin, or the published package through npx), adapted to where it's written.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { platform } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { isObject } from '../util.js';

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

/** `p` with every symlink resolved, or null if there's nothing there. */
function realPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
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

/** The newest modification time of any file under `dir`, or 0 if it has none. */
function newest(dir: string): number {
  let latest = 0;

  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);

    latest = Math.max(
      latest,
      e.isDirectory() ? newest(path) : statSync(path).mtimeMs,
    );
  }

  return latest;
}

/** Why the checkout at `root` can't serve the bridge as it is: a build missing or older than its source. */
function unbuilt(root: string): string | null {
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

/** The npx beside `node`, as node's installers put it; the PATH's on Windows, where it's a .cmd. */
function npxBeside(node: string): string {
  const npx = join(dirname(node), 'npx');

  return platform() !== 'win32' && existsSync(npx) ? npx : 'npx';
}

/**
 * The bridge command of the yea running as `node script`: this node and the checkout's bin, or
 * the published package through the npx beside this node. Both absolute, since an app may not
 * start them from a shell. Throws if the checkout isn't built.
 */
export function runningBridge(
  script = process.argv[1] ?? '',
  node = process.execPath,
): RunningBridge {
  const root = checkoutRoot(script);

  if (!root) {
    return {
      bridge: { command: npxBeside(node), args: PORTABLE_BRIDGE.args },
      checkout: null,
    };
  }

  const why = unbuilt(root);

  if (why) {
    throw new Error(
      `this checkout isn't built (${why}): run \`npm run build\` first, in ${root}`,
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
 * The bridge command a tool gets, from the running one: the one place an entry is built. A
 * project file gets the portable entry, so no personal path is committed. A desktop app's own
 * config also gets a PATH with this node's folder first: npx and the bridge's `#!/usr/bin/env
 * node` scripts need node there, and such an app doesn't start them from a shell.
 */
export function bridgeFor(
  { project, gui }: Placement,
  running: BridgeCommand,
  node = process.execPath,
): BridgeCommand {
  if (project) {
    return PORTABLE_BRIDGE;
  }

  const path = gui ? guiPath() : null;

  if (!path) {
    return running;
  }

  return {
    ...running,
    env: { ...running.env, PATH: `${dirname(node)}${delimiter}${path}` },
  };
}

/** `b` as a command line, for people to read. */
export function describeBridge(b: BridgeCommand): string {
  return [b.command, ...b.args]
    .map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a))
    .join(' ');
}

/** Whether `a` and `b` start the same thing the same way. */
export const sameBridge = (a: BridgeCommand, b: BridgeCommand) =>
  JSON.stringify([a.command, a.args, a.env ?? {}]) ===
  JSON.stringify([b.command, b.args, b.env ?? {}]);

/** A config's "yea" entry as a bridge command; throws what's wrong with it. */
export function parseBridge(v: unknown): BridgeCommand {
  if (!isObject(v) || typeof v.command !== 'string') {
    throw new Error('it has no command');
  }

  const args = v.args ?? [];

  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    throw new Error('its args are not a list of strings');
  }

  if (v.env === undefined) {
    return { command: v.command, args };
  }

  if (!isStringRecord(v.env)) {
    throw new Error('its env is not a table of strings');
  }

  return { command: v.command, args, env: v.env };
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  isObject(v) && Object.values(v).every((x) => typeof x === 'string');
