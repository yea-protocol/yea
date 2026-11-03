#!/usr/bin/env node
/**
 * The `yea` command: the SDK's CLI, so the CLI and library ship together. `yea mcp` runs the
 * bridge and `yea test-drive` drives it, both from @yea-protocol/mcp (the SDK can't depend on it
 * without a cycle), so they're handed to the SDK's `run` here, which still parses their flags
 * and prints their help.
 */
import { run } from '@yea-protocol/sdk/cli';

await run(process.argv.slice(2), {
  mcp: async (urls, o) => (await import('./mcp.js')).runMcp(urls, o),
  'test-drive': async (_args, _o, argv) =>
    (await import('@yea-protocol/mcp/test-drive')).runTestDrive(argv),
});
