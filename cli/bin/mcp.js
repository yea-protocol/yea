/**
 * `yea mcp [<url> …]`: YEA services as MCP tools over stdio, one per capability
 * (docs/framework/SPEC-bridge.md). With no URLs it serves the services added with `yea add`.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { bridge } from '@yea-protocol/mcp/bridge';
import {
  die,
  REQUIRE_INTERACTION_VALUES,
  requiresInteraction,
  UsageError,
} from '@yea-protocol/sdk/cli';
import {
  agentKey,
  connect,
  listServices,
  loadGrants,
} from '@yea-protocol/sdk/node';

const MODES = ['generic', 'per-capability'];

/**
 * Whether the tools that change things carry Claude Code's prompt-on-every-call key: the flag,
 * or `YEA_REQUIRE_INTERACTION`, for a plugin or `.mcp.json` whose arguments are fixed.
 * @param {boolean | undefined} flag `--require-interaction`
 */
function requireInteraction(flag) {
  const env = process.env.YEA_REQUIRE_INTERACTION;
  const on = requiresInteraction(env);

  if (on === null) {
    const values = Object.keys(REQUIRE_INTERACTION_VALUES).filter(Boolean);

    die(
      `yea mcp: YEA_REQUIRE_INTERACTION must be ${values.join(', ')} or empty, not ${JSON.stringify(env)}`,
    );
  }

  return flag === true || on === true;
}

/**
 * The command's options, checked; throws a `UsageError` for a bad value. `yea` has already
 * refused unknown flags.
 * @param {{ tools?: string, budget?: string }} o the flags
 */
function check(o) {
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
 * @param {{ tools?: string, budget?: string, name?: string, 'require-interaction'?: boolean }} o
 *   the flags, parsed by `yea` against `mcp`'s declaration in the SDK (cli/launch.ts)
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
