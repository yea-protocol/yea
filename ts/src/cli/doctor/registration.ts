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
  isPortableBridge,
  launchPath,
  type Scope,
  type Target,
} from '../../setup.js';
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

  const launch = launcher();
  // Every start is under way before the first is awaited.
  const lines = await Promise.all(found.map((f) => lineFor(f, launch)));

  for (const line of lines) {
    r.line(...line);
  }
}

/** `yea install`, naming the tools when it would find none by itself. */
function installCommand(): string {
  return detectedClients().length
    ? 'yea install'
    : `yea install --target <tool> (${Object.keys(CLIENTS).join(', ')})`;
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

/** What doctor says about `f`: why it can't read it or won't start it, or how starting it went. */
async function lineFor(f: Found, launch: Launcher): Promise<Line> {
  if ('why' in f) {
    return unreadable(f);
  }

  return refusal(f) ?? launchLine(f, await launch(f));
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

  return ['✗', f.replaceable ? `${line}: yea install --target ${f.id}` : line];
}

/** Why doctor won't start `f`, as its line; null if it will. */
function refusal(f: Registered): Line | null {
  if (f.path && !isAbsolute(f.bridge.command)) {
    return [
      '✗',
      `${f.name} starts "${f.bridge.command}" without your shell's PATH, so it may not find it: yea install --target ${f.id}`,
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

/** Start each distinct command once: the same command, args and environment start the same thing. */
function launcher(): Launcher {
  const started = new Map<string, Promise<Launch>>();

  return (f) => {
    const env = Object.entries(f.bridge.env ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const key = JSON.stringify([f.bridge.command, f.bridge.args, env, f.path]);
    const launch = started.get(key) ?? handshake(f.bridge, launchEnv(f));

    started.set(key, launch);

    return launch;
  };
}

/** The environment the tool starts `f` with: ours, its own PATH if it has one, then the entry's. */
const launchEnv = (f: Registered): NodeJS.ProcessEnv => ({
  ...process.env,
  ...(f.path ? { PATH: f.path } : {}),
  ...f.bridge.env,
});

/** What doctor says about starting `f`. */
export function launchLine(f: Registered, l: Launch): Line {
  if (l.kind === 'started') {
    return [
      '✓',
      `${f.name} starts the bridge (${l.ms} ms): ${describeBridge(f.bridge)}`,
    ];
  }

  if (l.kind === 'slow') {
    return [
      '!',
      `${f.name}: no answer within ${LAUNCH_TIMEOUT_MS / 1000} s (first runs download the bridge): run yea doctor again`,
    ];
  }

  if (l.kind === 'failed' && isUnpublished(f, l.stderr)) {
    return unpublished(f);
  }

  return ['✗', `${f.name}: the bridge didn't start: ${l.why}: ${fix(f, l)}`];
}

/** Whether `f` failed because npm has no copy of the published package. */
const isUnpublished = (f: Registered, stderr: string) =>
  f.bridge.args.includes('@yea-protocol/cli') && /\bE404\b/.test(stderr);

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
 * The command that fixes `f` when it doesn't start: register it again if its command isn't
 * there (the node it names was upgraded or removed), else rebuild its checkout, if it has one.
 */
function fix(f: Registered, l: Extract<Launch, { why: string }>): string {
  if (l.kind === 'unrunnable') {
    // A project file's is the bare npx, which install would write again: npx is what's missing.
    return f.project
      ? 'install node from nodejs.org, which comes with npx'
      : `yea install --target ${f.id}`;
  }

  const script = f.bridge.args[0];
  const root = script ? checkoutRoot(script) : null;

  return root
    ? `cd ${root} && npm ci && npm run build`
    : `yea install --target ${f.id}`;
}
