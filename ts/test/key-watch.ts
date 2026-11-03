/**
 * A watch on the two things any signing path needs, whatever crypto it uses (AGENTS.md rule 3,
 * #337): the principal key's bytes, which can only come from its file, and another process or
 * thread to sign in. It patches Node's own `fs`, `fs/promises`, `child_process`, `cluster` and
 * `worker_threads` in place and syncs their ES module bindings, so it sees code outside Vitest's
 * mocks too (an externalized package, a dynamic import), and puts them back when stopped.
 * mcp/test imports it by relative path, as the connectors import mcp/test/harness.ts.
 */

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

type Fn = (this: unknown, ...args: unknown[]) => unknown;
type Exports = Record<string, unknown>;

/** What was seen between `watchKeys` and `stop`. */
export interface KeyWatch {
  /** Each path that opened, read or copied one of the key files. */
  touched: string[];
  /** Each child process or worker started: its command, module or script. */
  spawned: string[];
  stop(): void;
}

// `require` reaches the real built-ins even in a test file that `vi.mock`s them.
const load = createRequire(import.meta.url);

/**
 * The functions that open, read or copy a file, by built-in module. A test that mocks `node:fs`
 * calls these through to the real module, so the watch reaches code under the mock.
 */
export const READS: [string, string[]][] = [
  [
    'node:fs',
    [
      'open',
      'openSync',
      'readFile',
      'readFileSync',
      'createReadStream',
      'copyFile',
      'copyFileSync',
      'cp',
      'cpSync',
      'openAsBlob',
    ],
  ],
  ['node:fs/promises', ['open', 'readFile', 'copyFile', 'cp']],
];

/** The functions that start another process. */
const SPAWNS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
];

/** A path as a string, or null for a file descriptor. */
function pathOf(p: unknown): string | null {
  if (typeof p === 'number') {
    return null;
  }

  return p instanceof URL ? fileURLToPath(p) : String(p);
}

/** Replace `name` on `mod` with `wrap(original)`, keeping its symbol properties. */
function patch(mod: Exports, name: string, wrap: (f: Fn) => Fn) {
  const original = mod[name];

  if (typeof original !== 'function') {
    return () => {};
  }

  const wrapped = wrap(original as Fn) as Fn & Record<symbol, unknown>;

  for (const s of Object.getOwnPropertySymbols(original)) {
    wrapped[s] = (original as unknown as Record<symbol, unknown>)[s];
  }

  mod[name] = wrapped;

  return () => {
    mod[name] = original;
  };
}

/** Whether `p` names one of the key files: by name, or by device and inode (links, copies' sources). */
function keyMatcher(keyFiles: string[]) {
  const { statSync } = load('node:fs') as typeof import('node:fs');
  const id = (f: string) => {
    const s = statSync(f);

    return `${s.dev}:${s.ino}`;
  };
  const ids = new Set(keyFiles.map(id));

  return (p: unknown) => {
    const path = pathOf(p);

    if (path === null) {
      return false;
    }

    try {
      return basename(path) === 'principal.key' || ids.has(id(path));
    } catch {
      return false;
    }
  };
}

/** Wrap `Worker` so each one started is recorded. */
function watchWorkers(spawned: string[]) {
  const threads = load('node:worker_threads') as Exports & {
    Worker: new (...args: unknown[]) => object;
  };
  const Real = threads.Worker;

  threads.Worker = class extends Real {
    constructor(...args: unknown[]) {
      spawned.push(`worker ${String(args[0])}`);
      super(...args);
    }
  };

  return () => {
    threads.Worker = Real;
  };
}

/** Start watching every way into `keyFiles` and every new process, until `stop()`. */
export function watchKeys(keyFiles: string[]): KeyWatch {
  const isKey = keyMatcher(keyFiles);
  const touched: string[] = [];
  const spawned: string[] = [];
  const restores: (() => void)[] = [];

  for (const [mod, names] of READS) {
    for (const name of names) {
      restores.push(
        patch(
          load(mod),
          name,
          (f) =>
            function (this: unknown, ...args: unknown[]) {
              if (isKey(args[0])) {
                touched.push(`${name} ${String(args[0])}`);
              }

              return f.apply(this, args);
            },
        ),
      );
    }
  }

  for (const [mod, name] of [
    ...SPAWNS.map((n) => ['node:child_process', n]),
    ['node:cluster', 'fork'],
  ]) {
    restores.push(
      patch(
        load(mod),
        name,
        (f) =>
          function (this: unknown, ...args: unknown[]) {
            spawned.push(`${name} ${String(args[0])}`);

            return f.apply(this, args);
          },
      ),
    );
  }

  restores.push(watchWorkers(spawned));
  syncBuiltinESMExports();

  return {
    touched,
    spawned,
    stop() {
      for (const restore of restores) {
        restore();
      }

      syncBuiltinESMExports();
    },
  };
}
