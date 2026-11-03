/**
 * Start an MCP server as an AI tool would and send it MCP's `initialize`: newline-delimited
 * JSON-RPC over stdio, by hand, since the SDK has no dependencies (AGENTS.md rule 4).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import type { BridgeCommand } from '../../setup.js';
import { isObject } from '../../util.js';

/** How a start went: it answered, it failed to start or answer, or it took too long. */
export type Launch =
  | { kind: 'started'; ms: number }
  | { kind: 'failed'; why: string; stderr: string }
  | { kind: 'slow'; ms: number };

/** Long enough for npx to download the bridge on a first run. */
export const LAUNCH_TIMEOUT_MS = 60_000;

/** How much of a server's stderr is kept, from the end. */
const STDERR_MAX = 8192;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'yea-doctor', version: '1' },
  },
};

/**
 * Start `b` with `env` and wait for its answer to `initialize`, then stop it. It starts in the
 * home folder, so nothing in the current one (a project's node_modules) is run instead.
 */
export function handshake(
  b: BridgeCommand,
  env: NodeJS.ProcessEnv,
  timeoutMs = LAUNCH_TIMEOUT_MS,
): Promise<Launch> {
  const t0 = Date.now();
  const child = spawn(b.command, b.args, {
    cwd: homedir(),
    env,
    stdio: 'pipe',
    // Windows starts a bare `npx` (npx.cmd) only through a shell.
    shell: process.platform === 'win32' && !isAbsolute(b.command),
  });
  let stderr = '';

  return new Promise((resolve) => {
    let settled = false;
    const settle = (l: Launch) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        stop(child);
        resolve(l);
      }
    };
    const timer = setTimeout(
      () => settle({ kind: 'slow', ms: Date.now() - t0 }),
      timeoutMs,
    );

    child.stderr?.on('data', (d) => {
      stderr = (stderr + d).slice(-STDERR_MAX);
    });
    child.on('error', (e) =>
      settle({ kind: 'failed', why: e.message, stderr }),
    );
    // 'close' comes after the last of stdout, so an answer just before exiting still counts.
    child.on('close', (code, signal) =>
      settle({ kind: 'failed', why: exited(code ?? signal, stderr), stderr }),
    );
    createInterface({ input: child.stdout }).on('line', (line) => {
      const l = answer(line, t0);

      if (l) {
        settle(l);
      }
    });
    child.stdin.on('error', () => {
      // EPIPE when it exits without reading: 'close' reports that.
    });
    child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
  });
}

/** What a line of stdout says, if it's the answer to `initialize`. */
function answer(line: string, t0: number): Launch | null {
  let msg: unknown;

  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isObject(msg) || msg.id !== INITIALIZE.id) {
    return null;
  }

  if ('result' in msg) {
    return { kind: 'started', ms: Date.now() - t0 };
  }

  const error = isObject(msg.error) ? String(msg.error.message) : 'no result';

  return {
    kind: 'failed',
    why: `it answered initialize with an error: ${error}`,
    stderr: '',
  };
}

/** Why a server that exited (with `status`) before answering did, from its stderr. */
function exited(status: number | string | null, stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const cause =
    lines.find((l) => /^(\w*Error\b|npm error|env: )/.test(l)) ?? lines.at(-1);

  return `it exited (${status}) before answering${cause ? `: ${cause}` : ''}`;
}

/** Stop `child` and let go of it: our ends of its pipes too, which a grandchild may hold open. */
function stop(child: ChildProcess) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.kill();
  child.unref();
}
