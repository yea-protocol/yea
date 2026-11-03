/**
 * `yea doctor`'s start-up check: each AI tool's registered bridge command, started the way that
 * tool starts it, and the one command that fixes it when it doesn't.
 */
import { isAbsolute } from 'node:path';
import {
  BadEntry,
  type BridgeCommand,
  CLIENTS,
  checkoutRoot,
  describeBridge,
  detectedClients,
  expandInteraction,
  isPortableBridge,
  launchPath,
  REQUIRE_INTERACTION_VALUES,
  requiresInteraction,
  type Scope,
  shellWord,
  type Target,
  unbuilt,
} from '../../setup.js';
import { self } from '../shared.js';
import { handshake, LAUNCH_TIMEOUT_MS, type Launch } from './handshake.js';
import type { Mark, Report } from './report.js';

/** An AI tool's "yea" entry, as doctor found it. */
export interface Registered {
  id: string;
  name: string;
  bridge: BridgeCommand;
  /** The PATH the tool starts it with, if not your shell's: a desktop app's. */
  path: string | null;
  /** Whether it's in a project file, which comes with the project. */
  project: boolean;
}

/** An entry doctor couldn't read, and why. */
interface Unreadable {
  id: string;
  name: string;
  why: string;
  project: boolean;
  /** Whether `yea install` replaces it: the config reads, but its entry isn't a bridge command. */
  replaceable: boolean;
}

type Found = Registered | Unreadable;

/** A doctor line: its mark and text. */
type Line = [Mark, string];

/** Starts an entry, or gives the start already under way for the same command. */
type Launcher = (f: Registered) => Promise<Launch>;

const UNPUBLISHED = "@yea-protocol/cli isn't on npm yet";

/** Report on each AI tool YEA is registered with: ✗ if none is, or one won't start. */
export async function checkRegistrations(r: Report, s: Scope): Promise<void> {
  const found = Object.entries(CLIENTS).flatMap(([id, t]) => find(id, t, s));

  if (!found.length) {
    return r.bad(`not registered with any AI tool: ${installCommand()}`);
  }

  const launch = launcher(shellEnv(r));
  // Every start is under way before the first is awaited.
  const lines = await Promise.all(found.map((f) => linesFor(f, launch)));

  for (const line of lines.flat()) {
    r.line(...line);
  }
}

/** `yea install`, naming the tools when it would find none by itself. */
function installCommand(): string {
  return detectedClients().length
    ? self('install')
    : self(`install --target <tool> (${Object.keys(CLIENTS).join(', ')})`);
}

/** Tool `t`'s entry under `s`, if it has one. */
function find(id: string, t: Target, s: Scope): Found[] {
  const placement = t.placement(s);
  const at = { id, name: t.name, project: placement.project };

  try {
    const bridge = t.registered(s);

    // A project file's entry starts with your shell's PATH, VS Code's included: see launchPath.
    return bridge ? [{ ...at, bridge, path: launchPath(placement) }] : [];
  } catch (e) {
    const why = (e as Error).message;

    return [{ ...at, why, replaceable: e instanceof BadEntry }];
  }
}

/**
 * What doctor says about `f`: why it can't read it or won't start it, or how starting it went,
 * and whether what started is an old build.
 */
async function linesFor(f: Found, launch: Launcher): Promise<Line[]> {
  if ('why' in f) {
    return [unreadable(f)];
  }

  const refused = refusal(f);

  if (refused) {
    return [refused];
  }

  const l = await launch(f);
  const stale = l.kind === 'started' ? staleBuild(f) : null;

  return [launchLine(f, l), ...(stale ? [stale] : [])];
}

/** The checkout `f` runs the bin of, if it does. */
function checkoutOf(f: Registered): string | null {
  const script = f.bridge.args[0];

  return script && isAbsolute(script) ? checkoutRoot(script) : null;
}

/** A warning when `f` starts a checkout's build that's older than its source: after a git pull. */
function staleBuild(f: Registered): Line | null {
  const root = checkoutOf(f);
  const why = root ? unbuilt(root) : null;

  return root && why
    ? [
        '!',
        `${f.name} starts an old build (${why}): cd ${shellWord(root)} && npm run build`,
      ]
    : null;
}

/** What doctor says about an entry it can't read: with `yea install`, if that replaces it. */
function unreadable(f: Unreadable): Line {
  if (f.project) {
    // The project ships it, and install would overwrite a file others may share.
    return [
      '!',
      `${f.name}: can't read the "yea" entry in its project file, which is the project's to fix: ${f.why}`,
    ];
  }

  const line = `${f.name}: can't read its "yea" entry: ${f.why}`;

  return [
    '✗',
    f.replaceable ? `${line}: ${self(`install --target ${f.id}`)}` : line,
  ];
}

/** Why doctor won't start `f`, as its line; null if it will. */
function refusal(f: Registered): Line | null {
  if (f.path && !isAbsolute(f.bridge.command)) {
    return [
      '✗',
      `${f.name} starts "${f.bridge.command}" without your shell's PATH, so it may not find it: ${self(`install --target ${f.id}`)}`,
    ];
  }

  // A project file comes with the project: start only what yea itself writes there.
  if (f.project && !isPortableBridge(f.bridge)) {
    return [
      '!',
      `${f.name}: its project file starts something other than yea's entry, which doctor won't run: ${describeBridge(f.bridge)}`,
    ];
  }

  return null;
}

/**
 * The environment doctor starts entries from: its own. A `YEA_REQUIRE_INTERACTION` there that
 * the bridge refuses is one warning, here, and is left out, rather than failing every entry that
 * would inherit or expand it.
 */
function shellEnv(r: Report): NodeJS.ProcessEnv {
  const { YEA_REQUIRE_INTERACTION: v, ...rest } = process.env;

  if (requiresInteraction(v) !== null) {
    return process.env;
  }

  const values = Object.keys(REQUIRE_INTERACTION_VALUES).filter(Boolean);

  r.warn(
    `YEA_REQUIRE_INTERACTION is ${JSON.stringify(v)} here, which the bridge refuses: an AI tool started from this shell won't start it. Set it to ${values.join(', ')} or unset it`,
  );

  return rest;
}

/** Start each distinct command once: the same command, args and environment start the same thing. */
function launcher(shell: NodeJS.ProcessEnv): Launcher {
  const started = new Map<string, Promise<Launch>>();

  return (f) => {
    const env = Object.entries(f.bridge.env ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const key = JSON.stringify([f.bridge.command, f.bridge.args, env, f.path]);
    const launch = started.get(key) ?? handshake(f.bridge, launchEnv(f, shell));

    started.set(key, launch);

    return launch;
  };
}

/**
 * The environment the tool starts `f` with: `shell`, its own PATH if it has one, then the
 * entry's, with the plugin's `YEA_REQUIRE_INTERACTION` reference expanded from `shell`.
 */
function launchEnv(f: Registered, shell: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const own = f.bridge.env?.YEA_REQUIRE_INTERACTION;

  return {
    ...shell,
    ...(f.path ? { PATH: f.path } : {}),
    ...f.bridge.env,
    ...(own === undefined
      ? {}
      : { YEA_REQUIRE_INTERACTION: expandInteraction(own, shell) }),
  };
}

/** What doctor says about starting `f`. */
export function launchLine(f: Registered, l: Launch): Line {
  if (l.kind === 'started') {
    return [
      '✓',
      `${f.name} starts the bridge (${l.ms} ms): ${describeBridge(f.bridge)}`,
    ];
  }

  if (l.kind === 'slow') {
    const after = `no answer within ${LAUNCH_TIMEOUT_MS / 1000} s`;

    return [
      '!',
      startsPublished(f)
        ? `${f.name}: ${after} (first runs download the bridge): run ${self('doctor')} again`
        : `${f.name}: ${after}: a service it connects to may not be answering: ${self('services')}`,
    ];
  }

  if (l.kind === 'failed' && isUnpublished(f, l.stderr)) {
    return unpublished(f);
  }

  return ['✗', `${f.name}: the bridge didn't start: ${l.why}: ${fix(f, l)}`];
}

/** Whether `f` starts the published package, through npx. */
const startsPublished = (f: Registered) =>
  f.bridge.args.includes('@yea-protocol/cli');

/** Whether `f` failed because npm has no copy of the published package. */
const isUnpublished = (f: Registered, stderr: string) =>
  startsPublished(f) && /\bE404\b/.test(stderr);

/** What doctor says when npm has no copy of the package `f` starts. */
function unpublished(f: Registered): Line {
  if (f.project) {
    // Nothing fixes it here: a project file gets only the published package.
    return [
      '!',
      `${f.name}: its project file starts the published package, and ${UNPUBLISHED}; it will start once it is`,
    ];
  }

  return [
    '✗',
    `${f.name}: the bridge didn't start: ${UNPUBLISHED}. From a clone of github.com/yea-protocol/yea: npm ci && npm run build && node cli/bin/yea.js install`,
  ];
}

/**
 * The command that fixes `f` when it doesn't start: rebuild its checkout if that's what's wrong,
 * else register it again, which names the node and checkout running doctor.
 */
function fix(f: Registered, l: Extract<Launch, { why: string }>): string {
  if (l.kind === 'unrunnable' && f.project) {
    // A project file's is the bare npx, which install would write again: npx is what's missing.
    return 'install node from nodejs.org, which comes with npx';
  }

  const root = l.kind === 'failed' ? checkoutOf(f) : null;
  const why = root ? unbuilt(root) : null;

  return root && why
    ? `its checkout isn't built (${why}): cd ${shellWord(root)} && npm ci && npm run build`
    : self(`install --target ${f.id}`);
}
