/**
 * `yea doctor`'s start-up check: each AI tool's registered bridge command, started the way that
 * tool starts it, and the one command that fixes it when it doesn't.
 */
import { isAbsolute } from 'node:path';
import {
  type BridgeCommand,
  bridgeFor,
  CLIENTS,
  checkoutRoot,
  describeBridge,
  detectedClients,
  guiPath,
  PORTABLE_BRIDGE,
  type Scope,
  sameBridge,
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
  try {
    const bridge = t.registered(s);
    const project = t.project(s);
    const path = t.gui && !project ? guiPath() : null;

    return bridge ? [{ id, name: t.name, bridge, path, project }] : [];
  } catch (e) {
    return [{ id, name: t.name, why: (e as Error).message }];
  }
}

async function lineFor(f: Found, launch: Launcher): Promise<Line> {
  if ('why' in f) {
    return [
      '✗',
      `${f.name}: can't read its "yea" entry: ${f.why}: yea install --target ${f.id}`,
    ];
  }

  return refusal(f) ?? launchLine(f, await launch(f));
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
  const ours = bridgeFor({ project: true, gui: false }, PORTABLE_BRIDGE);

  if (f.project && !sameBridge(f.bridge, ours)) {
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
    const key = JSON.stringify([
      f.bridge.command,
      f.bridge.args,
      f.bridge.env ?? {},
      f.path,
    ]);
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

  const unpublished =
    f.bridge.args.includes('@yea-protocol/cli') && /\bE404\b/.test(l.stderr);

  if (unpublished && f.project) {
    // Nothing fixes it here: a project file gets only the published package.
    return [
      '!',
      `${f.name}: its project file starts the published package, and ${UNPUBLISHED}; it will start once it is`,
    ];
  }

  const cause = unpublished
    ? `${UNPUBLISHED}. From a clone of github.com/yea-protocol/yea: npm ci && npm run build && node cli/bin/yea.js install`
    : `${l.why}: ${fix(f)}`;

  return ['✗', `${f.name}: the bridge didn't start: ${cause}`];
}

/** The command that fixes `f` when it doesn't start: rebuild its checkout, or register it again. */
function fix(f: Registered): string {
  const script = f.bridge.args[0];
  const root = script ? checkoutRoot(script) : null;

  return root
    ? `cd ${root} && npm ci && npm run build`
    : `yea install --target ${f.id}`;
}
