/**
 * `@yea-protocol/mcp/test-drive`: `yea test-drive`, a real Claude model using YEA live in your
 * terminal. The example calendar and shop run in-process behind the bridge (the tool host `yea
 * mcp` serves), with a throwaway principal, agent and home; the model gets the bridge's tools
 * through a thin tool-use adapter. When the bridge hands out a consent code, the test drive asks
 * YOU, in its own loop, and approves as `yea approve` would; the agent's tools never sign.
 * Needs an Anthropic API key (ANTHROPIC_API_KEY or an `ant auth login` profile).
 *
 * Only node builtins load before the Anthropic SDK is found: without it, `yea` re-runs itself
 * once through npx with it (test-drive/reexec.ts).
 */
import { parseArgs } from 'node:util';
import type { TestDriveOptions } from './test-drive/drive.js';
import { withPeerHint } from './test-drive/peers.js';
import {
  hasAnthropicSdk,
  reexecWithAnthropicSdk,
  stop,
} from './test-drive/reexec.js';

export type { TestDriveOptions } from './test-drive/drive.js';
export type { Confirm } from './test-drive/person.js';

const USAGE = 'usage: yea test-drive [--model <model>] ["task"]';

/**
 * Run one test drive. Needs the optional peers `@anthropic-ai/sdk` and
 * `@modelcontextprotocol/client` (`@yea-protocol/cli` brings the client); without one, it
 * throws an error that says how to install it.
 */
export async function testDrive(o: TestDriveOptions = {}): Promise<void> {
  try {
    const { drive } = await import('./test-drive/drive.js');

    await drive(o);
  } catch (e) {
    throw withPeerHint(e);
  }
}

/** The command's model and task; exits on a bad option. */
function options(args: string[]) {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        model: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });

    if (values.help) {
      console.log(USAGE);
      process.exit(0);
    }

    return { model: values.model, prompt: positionals.join(' ') || undefined };
  } catch (e) {
    stop(`yea test-drive: ${e instanceof Error ? e.message : e}\n${USAGE}`);
  }
}

/**
 * `yea test-drive [--model m] ["task"]`, from `yea`'s full arguments (`argv[0]` is
 * `test-drive`). Re-runs through npx when the Anthropic SDK can't be loaded here.
 */
export async function runTestDrive(argv: string[]): Promise<void> {
  const o = options(argv.slice(1));

  if (!(await hasAnthropicSdk())) {
    reexecWithAnthropicSdk(argv);
  }

  await testDrive(o);
  process.exit(0);
}
