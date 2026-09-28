/**
 * Control arm: a conventional REST-style MCP server (one tool per endpoint, JSON results)
 * over the SAME example services the YEA arm uses. It holds an unrestricted grant, like an
 * API key: writes happen immediately, with no preview, policy check or undo.
 *   node rest-mcp.ts <calendar url> <shop url>     (reads YEA_HOME for the agent key + grant)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '@yea-protocol/sdk/node';

const home = process.env.YEA_HOME!;
const key = readFileSync(join(home, 'agent.key'), 'utf8').trim();
const grants = readdirSync(join(home, 'grants')).map((f) =>
  readFileSync(join(home, 'grants', f), 'utf8').trim(),
);
const [calUrl, shopUrl] = process.argv.slice(2);
const cal = await connect(calUrl, { key, grants });
const shop = await connect(shopUrl, { key, grants });

const S = (d?: string) => ({
  type: 'string',
  ...(d ? { description: d } : {}),
});
const obj = (p: Record<string, unknown>, r: string[] = []) => ({
  type: 'object',
  properties: p,
  required: r,
});
const TOOLS = [
  {
    name: 'search_events',
    description:
      'Search calendar events by text in the title or attendee emails.',
    inputSchema: obj({ query: S() }, ['query']),
  },
  {
    name: 'list_events',
    description: 'List calendar events, optionally for one day (YYYY-MM-DD).',
    inputSchema: obj({ day: S() }),
  },
  {
    name: 'get_free_slots',
    description: 'Free 30-minute slots between 09:00 and 18:00 UTC on a day.',
    inputSchema: obj({ day: S('YYYY-MM-DD') }, ['day']),
  },
  {
    name: 'update_event',
    description:
      'Move an event to a new start time (ISO 8601). Attendees are notified.',
    inputSchema: obj({ id: S(), start: S() }, ['id', 'start']),
  },
  {
    name: 'delete_event',
    description: 'Cancel an event. Attendees are notified.',
    inputSchema: obj({ id: S() }, ['id']),
  },
  {
    name: 'search_meals',
    description:
      'Search the meal menu by text, tag (high-protein|spicy|vegetarian|vegan) or max calories.',
    inputSchema: obj({ query: S(), tag: S(), max_cal: { type: 'integer' } }),
  },
  {
    name: 'create_order',
    description:
      'Place a meal order for a delivery date (YYYY-MM-DD). Charges the saved card.',
    inputSchema: obj(
      {
        items: {
          type: 'array',
          items: obj({ sku: S(), qty: { type: 'integer' } }, ['sku', 'qty']),
        },
        deliver: S(),
      },
      ['items', 'deliver'],
    ),
  },
  {
    name: 'list_orders',
    description: 'List your meal orders.',
    inputSchema: obj({}),
  },
];

const data = async (
  c: typeof cal,
  cap: string,
  params: Record<string, unknown>,
) => {
  const r = await c.ask(cap, params, { budget: 1e6 });

  if (r.kind !== 'ANSWER') {
    throw new Error(r.lens);
  }

  return r.data;
};

async function write(
  c: typeof cal,
  cap: string,
  params: Record<string, unknown>,
) {
  const p = await c.intent(cap, params);

  if (p.kind !== 'PROPOSALS') {
    throw new Error(p.kind === 'CLARIFY' ? p.question : p.lens);
  }

  const r = await c.commit(p.proposals[0]);

  if (r.kind !== 'RECEIPT') {
    throw new Error(r.lens);
  }

  return { proposal: p.proposals[0], result: r.receipt.result };
}

// Tool arguments as the model sent them, per the TOOLS schemas above.
interface Args {
  query?: string;
  day?: string;
  id?: string;
  start?: string;
  tag?: string;
  max_cal?: number;
  items?: { sku: string; qty: number }[];
  deliver?: string;
}

async function call(name: string, a: Args): Promise<unknown> {
  switch (name) {
    case 'search_events':
      return data(cal, 'calendar.agenda', { query: a.query });
    case 'list_events':
      return data(cal, 'calendar.agenda', a.day ? { day: a.day } : {});
    case 'get_free_slots':
      return data(cal, 'calendar.free', { day: a.day });
    case 'update_event':
      await write(cal, 'calendar.reschedule', { event: a.id, to: a.start });

      return (await data(cal, 'calendar.agenda', { query: a.id })) as unknown;
    case 'delete_event':
      return (await write(cal, 'calendar.cancel', { event: a.id })).result;
    case 'search_meals':
      return data(
        shop,
        'shop.search',
        Object.fromEntries(
          Object.entries({
            query: a.query,
            tag: a.tag,
            max_cal: a.max_cal,
          }).filter(([, v]) => v !== undefined),
        ),
      );
    case 'create_order': {
      const { proposal, result } = await write(shop, 'shop.order', {
        items: a.items,
        deliver: a.deliver,
      });

      const spend = proposal.uses?.spend;

      return {
        ...(result as object),
        total_usd: spend ? spend.amount / 10 ** (spend.scale ?? 0) : 0,
      };
    }
    case 'list_orders':
      return data(shop, 'shop.orders', {});
  }

  throw new Error(`unknown tool ${name}`);
}

let buf = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk: string) => {
  buf += chunk;

  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const m = JSON.parse(buf.slice(0, nl));

    buf = buf.slice(nl + 1);

    const reply = (result: unknown) =>
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n`,
      );

    if (m.method === 'initialize') {
      reply({
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'rest-api', version: '1' },
      });
    } else if (m.method === 'tools/list') {
      reply({ tools: TOOLS });
    } else if (m.method === 'tools/call') {
      try {
        reply({
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                await call(m.params.name, m.params.arguments ?? {}),
              ),
            },
          ],
        });
      } catch (e) {
        reply({
          content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
          isError: true,
        });
      }
    } else if (m.id !== undefined) {
      reply({});
    }
  }
});
process.stdin.on('end', () => process.exit(0));
