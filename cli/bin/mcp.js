/**
 * `yea mcp [<url> …]`: YEA services as MCP tools over stdio, one per capability
 * (docs/framework/SPEC-bridge.md). With no URLs it serves the services added with `yea add`.
 */
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { bridge } from '@yea-protocol/mcp/bridge';
import { die } from '@yea-protocol/sdk/cli';
import {
  agentKey,
  connect,
  listServices,
  loadGrants,
} from '@yea-protocol/sdk/node';

const USAGE =
  'usage: yea mcp [<url> …] [--tools generic|per-capability] [--budget <tokens>] [--name <agent name>]';

const MODES = ['generic', 'per-capability'];

/**
 * The command's options and URLs, checked; exits on a bad one.
 * @param {string[]} argv the arguments after `mcp`
 */
function options(argv) {
  const { values: o, positionals: urls } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tools: { type: 'string' },
      budget: { type: 'string' },
      name: { type: 'string' },
      'approve-here': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (o.help) {
    console.log(USAGE);
    process.exit(0);
  }

  // TODO(#73): --approve-here (typed approval in the client, signed with a principal key on
  // this machine) waits for James (SPEC-bridge decision 4). Until then approvals use codes.
  if (o['approve-here']) {
    die('yea mcp: --approve-here is not available yet (#73); approve with `yea approve <code>`');
  }

  if (o.tools !== undefined && !MODES.includes(o.tools)) {
    die(`yea mcp: --tools must be one of ${MODES.join(', ')}\n${USAGE}`);
  }

  const budget = o.budget === undefined ? undefined : Number(o.budget);

  if (budget !== undefined && !(Number.isSafeInteger(budget) && budget > 0)) {
    die(`yea mcp: --budget must be a positive integer\n${USAGE}`);
  }

  return { o, urls, budget };
}

/**
 * Connect to each service and serve the bridge over stdio until stdin closes.
 * @param {string[]} argv the arguments after `mcp`
 */
export async function runMcp(argv) {
  const { o, urls, budget } = options(argv);
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
    const factory = await bridge(clients, { tools: o.tools, budget });

    serveStdio(factory);
    process.stdin.once('end', close);
  } catch (e) {
    close();
    die(e instanceof Error ? e.message : String(e));
  }
}
