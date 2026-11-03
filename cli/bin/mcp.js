/**
 * `yea mcp [<url> …]`: YEA services as MCP tools over stdio, one per capability
 * (docs/framework/SPEC-bridge.md). With no URLs it serves the services added with `yea add`.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { bridge } from '@yea-protocol/mcp/bridge';
import { die, UsageError } from '@yea-protocol/sdk/cli';
import {
  agentKey,
  connect,
  listServices,
  loadGrants,
} from '@yea-protocol/sdk/node';

const MODES = ['generic', 'per-capability'];

/** `YEA_REQUIRE_INTERACTION`'s accepted values; anything else is refused, not read as off. */
const SWITCH = { 1: true, true: true, 0: false, false: false, '': false };

/**
 * Whether the tools that change things carry Claude Code's prompt-on-every-call key: the flag,
 * or `YEA_REQUIRE_INTERACTION`, for a plugin or `.mcp.json` whose arguments are fixed.
 * @param {boolean | undefined} flag `--require-interaction`
 */
function requireInteraction(flag) {
  const env = process.env.YEA_REQUIRE_INTERACTION ?? '';

  if (!Object.hasOwn(SWITCH, env)) {
    die(
      `yea mcp: YEA_REQUIRE_INTERACTION must be 1, true, 0 or false, not ${JSON.stringify(env)}`,
    );
  }

  return flag === true || SWITCH[env];
}

/**
 * The command's options, checked; throws a `UsageError` for a bad value. `yea` has already
 * refused unknown flags.
 * @param {{ tools?: string, budget?: string, 'approve-here'?: boolean }} o the flags
 */
function check(o) {
  // TODO(#73): --approve-here (typed approval in the client, signed with a principal key on
  // this machine) waits for James (SPEC-bridge decision 4). Until then approvals use codes.
  if (o['approve-here']) {
    die('yea mcp: --approve-here is not available yet (#73); approve with `yea approve <code>`');
  }

  if (o.tools !== undefined && !MODES.includes(o.tools)) {
    throw new UsageError(`--tools must be one of ${MODES.join(', ')}`);
  }

  // Digits only: Number() alone would also take 0x10, 1e3 or " 5 ".
  const budget =
    o.budget !== undefined && /^\d+$/.test(o.budget) ? Number(o.budget) : undefined;

  if (
    o.budget !== undefined &&
    !(budget !== undefined && Number.isSafeInteger(budget) && budget > 0)
  ) {
    throw new UsageError('--budget must be a positive integer');
  }

  return budget;
}

/**
 * Connect to each service and serve the bridge over stdio until stdin closes.
 * @param {string[]} urls the services; none means those added with `yea add`
 * @param {{ tools?: string, budget?: string, name?: string, 'require-interaction'?: boolean,
 *   'approve-here'?: boolean }} o the flags, parsed by `yea` against `mcp`'s declaration in the SDK (cli/launch.ts)
 */
export async function runMcp(urls, o) {
  const budget = check(o);
  const prompt = requireInteraction(o['require-interaction']);
  const agent = await agentKey();
  // Grants only: the bridge reads each consent from ~/.yea/consents for the proposal it commits.
  const grants = loadGrants('grants');
  const clients = [];

  for (const url of urls.length ? urls : listServices()) {
    try {
      const client = await connect(url, {
        key: agent?.seed,
        grants,
        name: o.name ?? 'yea-mcp',
      });

      clients.push({ client, url });
    } catch (e) {
      console.error(`yea mcp: ${url}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const close = () => {
    for (const c of clients) {
      c.client.close();
    }
  };

  try {
    const factory = await bridge(clients, {
      tools: o.tools,
      budget,
      requireInteraction: prompt,
    });

    serveStdio(factory);
    process.stdin.once('end', close);
  } catch (e) {
    close();
    die(e instanceof Error ? e.message : String(e));
  }
}
