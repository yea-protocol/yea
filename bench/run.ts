/**
 * YEA vs. a typical REST-wrapper MCP server: the same tasks, over the same data.
 * Measures what the model has to read, with a real BPE tokenizer (o200k_base).
 * Both sides return the same information; only the protocol differs.
 * YEA's side is what `yea mcp` ships: the bridge from `@yea-protocol/mcp/bridge`, in-process,
 * with `yea mcp`'s default options, read through an MCP client.
 * Deterministic: ids, keys and handles come from a seeded PRNG and the clock is fixed, so every
 * run prints the same numbers.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/client';
import {
  type CallToolResult,
  InMemoryTransport,
} from '@modelcontextprotocol/server';
import { bridge } from '@yea-protocol/mcp/bridge';
import { Client, issueGrant, keyPair, local } from '@yea-protocol/sdk';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { calendar } from '../examples/calendar.ts';
import { shop } from '../examples/shop.ts';

let seed = 0x9e3779b9;

globalThis.crypto.getRandomValues = (<T extends ArrayBufferView | null>(
  a: T,
): T => {
  const view = a as ArrayBufferView;
  const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

  for (let i = 0; i < u8.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    u8[i] = seed & 0xff;
  }

  return a;
}) as typeof globalThis.crypto.getRandomValues;

/** Every run happens at this instant: the example calendar and the receipts' dates come from it. */
const NOW = Date.parse('2026-10-15T08:00:00Z');

/** `Date` with the clock stopped at `NOW`; dates given explicitly are unchanged. */
class FixedDate extends Date {
  constructor(...args: unknown[]) {
    if (args.length) {
      super(...(args as [string]));
    } else {
      super(NOW);
    }
  }

  static override now() {
    return NOW;
  }
}

globalThis.Date = FixedDate as DateConstructor;

// A fresh YEA home, so the person's ~/.yea (its consents, and policy.json's `deny`) can't change
// what the bridge does.
const HOME = mkdtempSync(join(tmpdir(), 'yea-bench-'));

process.env.YEA_HOME = HOME;

const tok = (s: string) => encode(s).length;

// ---------- the YEA side: the example services behind the bridge `yea mcp` runs ----------
const principal = await keyPair(),
  agent = await keyPair();
const grant = await issueGrant({ principal, to: agent.public });
const cal = new Client(local(calendar({ trust: [principal.public] })), {
  key: agent.seed,
  grants: [grant],
});
const sh = new Client(local(shop({ trust: [principal.public] })), {
  key: agent.seed,
  grants: [grant],
});

/** One tool call: what the model sent, the text it read back, and the structured data beside it. */
interface Call {
  args: unknown;
  result: string;
  structured?: Record<string, unknown>;
}

/** An MCP client connected to a bridge over the services, and what it put in the model's context. */
async function connectBridge(budget?: number) {
  const factory = await bridge(
    [
      { client: cal, url: 'calendar' },
      { client: sh, url: 'shop' },
    ],
    budget === undefined ? {} : { budget },
  );
  const client = new McpClient({ name: 'yea-bench', version: '0.0.0' });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();

  await factory().connect(serverEnd);
  await client.connect(clientEnd);

  const { tools } = await client.listTools();
  const instructions = client.getInstructions() ?? '';
  // What a model API takes for a tool, the same fields as the REST side's definitions.
  const forModel = tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));

  return {
    tools,
    /** Counted: each tool's name, description and inputSchema, then the instructions. */
    defs: `${JSON.stringify(forModel)}\n${instructions}`,
    /** For the caveat: all of `tools/list`, with `annotations` and `_meta`. */
    fullDefs: `${JSON.stringify(tools)}\n${instructions}`,
    async call(name: string, args: Record<string, unknown>): Promise<Call> {
      const r = (await client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
      const text = r.content.flatMap((c) =>
        c.type === 'text' ? [c.text] : [],
      );

      if (r.isError) {
        throw new Error(`${name}: ${text.join('\n')}`);
      }

      return {
        args: { name, arguments: args },
        result: text.join('\n'),
        structured: r.structuredContent,
      };
    },
  };
}

/** The bridge `yea mcp` runs with its default options, and one started with `--budget 800`. */
const yeaMcp = await connectBridge();
const yeaMcp800 = await connectBridge(800);
const yeaDefs = yeaMcp.defs;

if (yeaMcp800.defs !== yeaDefs) {
  throw new Error('the --budget 800 bridge sends different definitions');
}

/** The receipt id a committed job call returned. */
function receiptId(c: Call): string {
  const receipt = c.structured?.receipt;

  if (
    typeof receipt !== 'object' ||
    receipt === null ||
    !('id' in receipt) ||
    typeof receipt.id !== 'string'
  ) {
    throw new Error(`expected a receipt, got: ${c.result}`);
  }

  return receipt.id;
}

// ---------- the REST side: a conventional MCP server (one tool per endpoint, JSON in/out) ----------
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: props,
  required,
});
const S = (description?: string) => ({
  type: 'string',
  ...(description ? { description } : {}),
});
const I = (description?: string) => ({
  type: 'integer',
  ...(description ? { description } : {}),
});
const REST_TOOLS = [
  {
    name: 'search_events',
    description:
      'Search calendar events by text in the title or attendee emails. Returns matching events.',
    inputSchema: obj({ query: S('Search text') }, ['query']),
  },
  {
    name: 'list_events',
    description:
      'List calendar events, optionally filtered to a single day (YYYY-MM-DD).',
    inputSchema: obj({ day: S('Day in YYYY-MM-DD format') }),
  },
  {
    name: 'get_free_slots',
    description: 'Get free time slots between 09:00 and 18:00 UTC on a day.',
    inputSchema: obj(
      {
        day: S('Day in YYYY-MM-DD format'),
        minutes: I('Slot length in minutes (default 30)'),
      },
      ['day'],
    ),
  },
  {
    name: 'update_event',
    description:
      "Update an event's start and end time. Attendees are notified.",
    inputSchema: obj(
      {
        id: S('Event id'),
        start: S('New start time, ISO 8601'),
        end: S('New end time, ISO 8601'),
      },
      ['id', 'start', 'end'],
    ),
  },
  {
    name: 'delete_event',
    description: 'Delete (cancel) an event. Attendees are notified.',
    inputSchema: obj(
      { id: S('Event id'), note: S('Optional note to attendees') },
      ['id'],
    ),
  },
  {
    name: 'create_event',
    description: 'Create an event and invite attendees.',
    inputSchema: obj(
      {
        title: S(),
        start: S('ISO 8601'),
        end: S('ISO 8601'),
        attendees: { type: 'array', items: S('email') },
      },
      ['title', 'start', 'end', 'attendees'],
    ),
  },
  {
    name: 'reschedule_event',
    description:
      'Move a meeting matching a query to the first free slot on a day. Attendees are notified.',
    inputSchema: obj(
      { query: S('Search text'), day: S('Day in YYYY-MM-DD format') },
      ['query', 'day'],
    ),
  },
  {
    name: 'search_meals',
    description:
      'Search the meal delivery menu. Filter by text, dietary tag, or maximum calories.',
    inputSchema: obj({
      query: S(),
      tag: {
        type: 'string',
        enum: ['high-protein', 'spicy', 'vegetarian', 'vegan'],
      },
      max_cal: I('Maximum calories'),
      limit: I('Max results'),
    }),
  },
  {
    name: 'create_order',
    description:
      'Place a meal order for a delivery date. Charges the saved card.',
    inputSchema: obj(
      {
        items: {
          type: 'array',
          items: obj({ sku: S(), qty: I() }, ['sku', 'qty']),
        },
        deliver: S('Delivery date YYYY-MM-DD'),
      },
      ['items', 'deliver'],
    ),
  },
  {
    name: 'list_orders',
    description: 'List your meal orders with their totals and status.',
    inputSchema: obj({}),
  },
  {
    name: 'tip_courier',
    description: 'Tip the courier for an order. Charges the saved card.',
    inputSchema: obj({ order: S('Order id'), usd: { type: 'number' } }, [
      'order',
      'usd',
    ]),
  },
];
const restDefs = JSON.stringify(REST_TOOLS);

// REST payloads are built from the *same* data the YEA services return.
// Rows as the example services return them.
interface AgendaRow {
  id: string;
  title: string;
  start: string;
  end: string;
  with: string;
}
interface MealRow {
  sku: string;
  name: string;
  usd: number;
  cal: number;
  protein: number;
}

const data = async <T>(
  c: Client,
  cap: string,
  params: Record<string, unknown>,
) => {
  const r = await c.ask(cap, params, { budget: 1e6 });

  if (r.kind !== 'ANSWER') {
    throw new Error(r.lens);
  }

  return r.data as T;
};
const restEvent = (e: AgendaRow) => ({
  id: e.id,
  title: e.title,
  start: e.start,
  end: e.end,
  attendees: e.with.split(' '),
});
const menuRow = (m: MealRow) => ({
  sku: m.sku,
  name: m.name,
  price_usd: m.usd,
  calories: m.cal,
  protein_g: m.protein,
});

interface Run {
  calls: Call[];
}
interface Task {
  name: string;
  rest: (J: (v: unknown) => string) => Run;
  yea: Run;
}

const DAY = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);

/**
 * 1. Reschedule a meeting into a free slot. REST gets the usual CRUD tools *and*, as a separate
 *    row, an outcome-level endpoint, so the protocol isn't credited for API design.
 */
async function rescheduleTasks(): Promise<Task[]> {
  const ev = (
    await data<AgendaRow[]>(cal, 'calendar.agenda', { query: '1:1 Ana' })
  ).map(restEvent);
  const free = await data<{ day: string; slots: string[] }>(
    cal,
    'calendar.free',
    { day: DAY, minutes: 30 },
  );
  const moved = {
    ...ev[0],
    start: free.slots[0],
    end: new Date(Date.parse(free.slots[0]) + 1800e3)
      .toISOString()
      .replace('.000Z', 'Z'),
    updated: true,
  };
  const yeaCall = await yeaMcp.call('calendar_reschedule', {
    event: '1:1 Ana',
    day: DAY,
  });

  await cal.undo(receiptId(yeaCall)); // keep data identical across tasks

  const yea = { calls: [yeaCall] };

  return [
    {
      name: 'Reschedule a meeting (REST: search → free slots → update)',
      rest: (J) => ({
        calls: [
          {
            args: { name: 'search_events', arguments: { query: '1:1 Ana' } },
            result: J(ev),
          },
          {
            args: {
              name: 'get_free_slots',
              arguments: { day: DAY, minutes: 30 },
            },
            result: J(free),
          },
          {
            args: {
              name: 'update_event',
              arguments: { id: ev[0].id, start: moved.start, end: moved.end },
            },
            result: J(moved),
          },
        ],
      }),
      yea,
    },
    {
      name: 'Reschedule a meeting (REST: one outcome-level endpoint)',
      rest: (J) => ({
        calls: [
          {
            args: {
              name: 'reschedule_event',
              arguments: { query: '1:1 Ana', day: DAY },
            },
            result: J(moved),
          },
        ],
      }),
      yea,
    },
  ];
}

/** 2. Find vegan meals under 700 kcal and order four. */
async function orderTask(): Promise<Task> {
  const found = await data<MealRow[]>(sh, 'shop.search', {
    tag: 'vegan',
    max_cal: 700,
  });
  const picked = found.slice(0, 2);
  const items = picked.map((m) => ({ sku: m.sku, qty: 2 }));
  const lines = picked.map((m) => ({
    sku: m.sku,
    name: m.name,
    qty: 2,
    unit_price: m.usd,
  }));
  const subtotal =
    Math.round(lines.reduce((s, l) => s + l.unit_price * 100 * l.qty, 0)) / 100;
  const order = {
    id: 'o1001',
    status: 'placed',
    deliver: DAY,
    items: lines,
    subtotal,
    delivery_fee: subtotal >= 50 ? 0 : 5.99,
    total: Math.round((subtotal + (subtotal >= 50 ? 0 : 5.99)) * 100) / 100,
    currency: 'USD',
    cancellable_until: '2026-01-01T02:00:00Z',
  };
  const search = await yeaMcp.call('shop_search', {
    tag: 'vegan',
    max_cal: 700,
  });
  const placed = await yeaMcp.call('shop_order', { items, deliver: DAY });

  receiptId(placed); // it committed

  return {
    name: 'Find vegan meals < 700 kcal and order four',
    rest: (J) => ({
      calls: [
        {
          args: {
            name: 'search_meals',
            arguments: { tag: 'vegan', max_cal: 700 },
          },
          result: J(found.map(menuRow)),
        },
        {
          args: { name: 'create_order', arguments: { items, deliver: DAY } },
          result: J(order),
        },
      ],
    }),
    yea: { calls: [search, placed] },
  };
}

/** 3. Read the whole 60-item menu (same content both ways; pure encoding cost). */
async function menuTask(): Promise<Task> {
  const all = await data<MealRow[]>(sh, 'shop.search', {});
  const read = await yeaMcp.call('shop_search', {});

  return {
    name: 'Read the full 60-item menu',
    rest: (J) => ({
      calls: [
        {
          args: { name: 'search_meals', arguments: {} },
          result: J(all.map(menuRow)),
        },
      ],
    }),
    yea: { calls: [read] },
  };
}

/**
 * 4. Skim the menu. `yea mcp`'s default budget (1500) fits the whole menu, and its tools take no
 *    budget, so YEA skims on a second bridge started with `--budget 800`. REST gets `limit` set
 *    to the number of items YEA returned: the same items both ways, and YEA also says what's left.
 */
async function skimTask(): Promise<Task> {
  const all = await data<MealRow[]>(sh, 'shop.search', {});
  const read = await yeaMcp800.call('shop_search', {});
  const page = read.structured?.data;
  const shown = Array.isArray(page) ? page.length : 0;

  return {
    name: `Skim the menu (first ${shown} items: REST limit=${shown}, YEA on a second bridge at --budget 800)`,
    rest: (J) => ({
      calls: [
        {
          args: { name: 'search_meals', arguments: { limit: shown } },
          result: J(all.slice(0, shown).map(menuRow)),
        },
      ],
    }),
    yea: { calls: [read] },
  };
}

const tasks = async (): Promise<Task[]> => [
  ...(await rescheduleTasks()),
  await orderTask(),
  await menuTask(),
  await skimTask(),
];

/**
 * What the model pays: every turn re-reads tool definitions + the conversation so far. With
 * `structured`, each result also counts its `structuredContent` (for the caveat).
 */
function cost(defs: string, run: Run, structured = false) {
  const d = tok(defs);
  let history = 0,
    cumulative = 0,
    read = 0;

  for (const c of run.calls) {
    cumulative += d + history; // input tokens for the turn that emits this call

    const call = tok(JSON.stringify(c.args)),
      res =
        tok(c.result) +
        (structured && c.structured ? tok(JSON.stringify(c.structured)) : 0);

    history += call + res;
    read += res;
  }

  cumulative += d + history; // final turn: answer the user

  return { calls: run.calls.length, read, cumulative, defs: d };
}

const lines: string[] = [];
const log = (s = '') => {
  console.log(s);
  lines.push(s);
};
const pct = (a: number, b: number) => `${Math.round((1 - b / a) * 100)}%`;
/** `b` against `a` in words: "21% more" or "32% fewer". */
const vs = (a: number, b: number) =>
  b > a
    ? `${Math.round((b / a - 1) * 100)}% more`
    : `${Math.round((1 - b / a) * 100)}% fewer`;
const n = (x: number) => x.toLocaleString('en-US');
const minJ = (v: unknown) => JSON.stringify(v),
  prettyJ = (v: unknown) => JSON.stringify(v, null, 2);

/** The rows the "All tasks" total adds up: every task but the outcome-level reschedule. */
const counted = (T: Task[]) =>
  T.filter((t) => !t.name.includes('outcome-level'));

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The table: each task's total input, REST minified and pretty against YEA, and the sum. */
function table(T: Task[]) {
  log(
    `| Task | Calls (REST → YEA) | Total input: REST minified JSON | REST pretty JSON | YEA | Saved vs minified | vs pretty |`,
  );
  log(`|---|---|---|---|---|---|---|`);

  for (const t of T) {
    const m = cost(restDefs, t.rest(minJ)),
      pr = cost(restDefs, t.rest(prettyJ)),
      px = cost(yeaDefs, t.yea);

    log(
      `| ${t.name} | ${m.calls} → ${px.calls} | ${n(m.cumulative)} | ${n(pr.cumulative)} | ${n(px.cumulative)} | **${pct(m.cumulative, px.cumulative)}** | ${pct(pr.cumulative, px.cumulative)} |`,
    );
  }

  const C = counted(T);
  const SM = sum(C.map((t) => cost(restDefs, t.rest(minJ)).cumulative)),
    SP = sum(C.map((t) => cost(restDefs, t.rest(prettyJ)).cumulative)),
    SX = sum(C.map((t) => cost(yeaDefs, t.yea).cumulative));

  log(
    `| **All tasks** (CRUD reschedule row) | | ${n(SM)} | ${n(SP)} | ${n(SX)} | **${pct(SM, SX)}** | ${pct(SP, SX)} |\n`,
  );
  log(
    `Result tokens read, per task (minified REST → YEA): ${T.map((t) => `${cost(restDefs, t.rest(minJ)).read} → ${cost(yeaDefs, t.yea).read}`).join(' · ')}\n`,
  );

  return { SM, SX };
}

/** What changed in #297, and the figures the counting leaves out. */
function caveat(T: Task[], all: { SM: number; SX: number }) {
  const C = counted(T);
  const structured = sum(
    C.flatMap((t) =>
      t.yea.calls.map((c) =>
        c.structured ? tok(JSON.stringify(c.structured)) : 0,
      ),
    ),
  );
  const fullDefs = sum(
    C.map((t) => cost(yeaMcp.fullDefs, t.yea, true).cumulative),
  );

  log(`## What changed, and why the numbers moved\n`);
  log(
    `Until #297 this benchmark counted YEA's side as \`yea test-drive\`'s 4 generic tools, its instructions and two HELLO briefs (**687** tokens of definitions), with each service's own Lens as results. No \`yea mcp\` user gets that surface. It now connects an MCP client to \`bridge()\` from \`@yea-protocol/mcp/bridge\` in-process, with \`yea mcp\`'s default options, and counts what the bridge sends: \`tools/list\` and its instructions as definitions, and each tool call's text as results. The definitions grew from 687 to **${n(tok(yeaDefs))}** tokens, and they're re-read every turn, so over all tasks YEA went from 32% fewer tokens than minified-JSON REST to **${vs(all.SM, all.SX)}**. Shrinking the bridge's definitions is [#300](https://github.com/yea-protocol/yea/issues/300).\n`,
  );
  log(
    `- Definitions count each tool's \`name\`, \`description\` and \`inputSchema\`, the fields a model API takes and the ones the REST side has. All of \`tools/list\`, with \`annotations\` and \`_meta\`, is **${n(tok(yeaMcp.fullDefs))}** tokens.`,
  );
  log(
    `- Results count each call's text content. The \`structuredContent\` beside it is another **${n(structured)}** tokens over the counted tasks. Counting all of \`tools/list\` and \`structuredContent\` too, YEA's all-tasks total is **${n(fullDefs)}**, ${vs(all.SM, fullDefs)} than minified-JSON REST.`,
  );
  log(
    `- The skim row runs on a second bridge started with \`budget: 800\` (\`yea mcp --budget 800\`): at the default 1500 the whole menu fits in one reply, and the bridge's tools take no budget.\n`,
  );
}

function report(T: Task[]) {
  log(`# YEA vs REST-style MCP — token benchmark\n`);
  log(
    `Tokenizer: o200k_base (gpt-tokenizer). Claude's tokenizer differs; the ratios are what matter. Both sides serve the same data. Ids are seeded and the clock is fixed, so runs are reproducible.\n`,
  );
  log(
    `**Total input** counts what you pay for: each model turn re-reads the tool definitions plus the conversation so far (calls and results), and there's one final turn to answer.\n`,
  );

  const utilities = yeaMcp.tools.filter((t) => t.name.startsWith('yea_'));

  log(
    `Tool definitions in context every turn: REST MCP **${tok(restDefs)}** tokens (${REST_TOOLS.length} tools) vs YEA **${n(tok(yeaDefs))}** (\`yea mcp\`'s ${yeaMcp.tools.length} tools: ${yeaMcp.tools.length - utilities.length} per capability, plus ${utilities.map((t) => t.name).join(', ')}; and its instructions).\n`,
  );

  const all = table(T);

  caveat(T, all);
  log(`## What the model actually reads\n`);

  const cr = T[0];

  log(
    `### Reschedule, REST CRUD (3 calls, pretty JSON)\n\n\`\`\`json\n${cr
      .rest(prettyJ)
      .calls.map((c) => c.result)
      .join('\n\n')}\n\`\`\`\n`,
  );
  log(
    `### Reschedule, YEA (1 call through the bridge, auto-commit)\n\n\`\`\`\n${cr.yea.calls.map((c) => c.result).join('\n\n')}\n\`\`\`\n`,
  );
  log(
    `What the tokens don't show: the YEA agent acted only because the principal's grant allows low-risk, undoable changes, and it got back exactly what happened with a 24h undo window. In the auto-commit case the *service* chose the slot (the first free one), just like the REST outcome endpoint. An agent that wants to choose calls with \`preview: true\`, gets three proposals, and commits one with \`proposal\`.`,
  );
}

try {
  report(await tasks());
  writeFileSync(
    new URL('./RESULTS.md', import.meta.url),
    `${lines.join('\n')}\n`,
  );
} finally {
  cal.close();
  sh.close();
  rmSync(HOME, { recursive: true, force: true });
}
