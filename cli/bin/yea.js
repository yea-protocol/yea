#!/usr/bin/env node
/**
 * The `yea` command. `yea mcp` runs the bridge and `yea test-drive` drives it, both from
 * @yea-protocol/mcp (the SDK can't depend on it without a cycle); everything else is the SDK's
 * CLI, so the CLI and library ship together.
 */
if (process.argv[2] === 'mcp') {
  const { runMcp } = await import('./mcp.js');

  await runMcp(process.argv.slice(3));
} else if (process.argv[2] === 'test-drive') {
  const { runTestDrive } = await import('@yea-protocol/mcp/test-drive');

  await runTestDrive(process.argv.slice(2));
} else {
  const { run } = await import('@yea-protocol/sdk/cli');

  await run(process.argv.slice(2));
}
