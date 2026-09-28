#!/usr/bin/env node
// The `yea` command. `yea mcp` runs the bridge from @yea-protocol/mcp (the SDK can't depend on
// it without a cycle); everything else is the SDK's CLI, so the CLI and library ship together.
if (process.argv[2] === 'mcp') {
  const { runMcp } = await import('./mcp.js');

  await runMcp(process.argv.slice(3));
} else {
  await import('@yea-protocol/sdk/cli');
}
