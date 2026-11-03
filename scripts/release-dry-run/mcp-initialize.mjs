/**
 * The MCP handshake's first step over stdio: start a server, send it
 * `initialize` as one JSON-RPC line, and wait for its answer, the way an MCP
 * client does when it launches `yea mcp`.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** How long a server gets to answer. */
const TIMEOUT_MS = 15_000;

/** The request, as a client with no capabilities sends it. */
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'yea-release-dry-run', version: '0.0.0' },
  },
};

/** The reply to `initialize` in a stdout `line`, or undefined if it isn't one. */
function replyIn(line) {
  try {
    const message = JSON.parse(line);

    return message.id === INITIALIZE.id ? message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `serverInfo` the running `server` answers `initialize` with. Rejects on
 * an error reply, an exit, or no answer in `timeoutMs`.
 */
function answer(server, timeoutMs) {
  const stderr = [];
  let timer;

  server.stderr.on('data', (chunk) => stderr.push(chunk));

  return new Promise((resolve, reject) => {
    const fail = (why) =>
      reject(new Error(`${why}\n${Buffer.concat(stderr)}`.trim()));

    timer = setTimeout(fail, timeoutMs, `no answer in ${timeoutMs} ms`);
    createInterface({ input: server.stdout }).on('line', (line) => {
      const reply = replyIn(line);

      if (reply?.result?.serverInfo) {
        resolve(reply.result.serverInfo);
      } else if (reply) {
        fail(`initialize failed: ${line}`);
      }
    });
    server.on('error', (error) => fail(error.message));
    server.on('exit', (code) => fail(`exited (${code}) before answering`));
    server.stdin.on('error', (error) => fail(`stdin: ${error.message}`));
    server.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
  }).finally(() => clearTimeout(timer));
}

/**
 * Starts `command` with `args` and `env`, sends `initialize`, and resolves
 * with the server's `serverInfo`. The server is stopped either way.
 */
export async function initialize(command, args, options = {}) {
  const { env = process.env, timeoutMs = TIMEOUT_MS } = options;
  const server = spawn(command, args, { env, stdio: 'pipe' });

  try {
    return await answer(server, timeoutMs);
  } finally {
    server.kill();
  }
}
