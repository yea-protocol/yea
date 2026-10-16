/**
 * The test drive's optional peers: `@yea-protocol/mcp` serves MCP without them, so a library
 * caller of the test drive may not have one. A missing one is named, with how to install it.
 */

/** The optional peers the test drive loads, only when it runs. */
export const OPTIONAL_PEERS = [
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/client',
];

/** Whether `e` is Node's error for a package that can't be found. */
const notFound = (e: unknown): e is Error =>
  e instanceof Error &&
  (e as Error & { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND';

/**
 * `e`, or, when it says one of the optional peers can't be found, an error that names it and
 * how to install it (the original as its cause).
 */
export function withPeerHint(e: unknown): unknown {
  const peer = notFound(e)
    ? OPTIONAL_PEERS.find((p) => e.message.includes(`'${p}'`))
    : undefined;

  return peer
    ? new Error(
        `yea test-drive needs ${peer}, an optional peer of @yea-protocol/mcp: npm install ${peer}`,
        { cause: e },
      )
    : e;
}
