/**
 * YEA vs. a typical REST-wrapper MCP server: the same tasks, over the same data.
 * Measures what the model has to read, with a real BPE tokenizer (o200k_base).
 * Both sides return the same information; only the protocol differs.
 * Deterministic: ids, keys and handles come from a seeded PRNG, so every run prints the same numbers.
 */

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

import { writeFileSync } from 'node:fs';
import {
  Client,
  INSTRUCTIONS,
  issueGrant,
  keyPair,
  local,
  TOOLS as YEA_TOOLS,
} from '@yea-protocol/sdk';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { calendar } from '../examples/calendar.ts';
import { shop } from '../examples/shop.ts';

const tok = (s: string) => encode(s).length;

// ---------- the YEA side: services behind the four generic tools (yea test-drive; `yea mcp` before #73) ----------
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
const briefs = [(await cal.hello(1500)).lens, (await sh.hello(1500)).lens];
const yeaDefs = `${JSON.stringify(YEA_TOOLS)}\n${INSTRUCTIONS}${briefs.join('\n\n')}`;

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

interface Call {
  args: unknown;
  result: string;
}
interface Run {
  calls: Call[];
}
interface Task {
  name: string;
  note?: string;
  rest: (J: (v: unknown) => string) => Run;
  yea: Run;
}

const DAY = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);

async function tasks(): Promise<Task[]> {
  const out: Task[] = [];
  const menuRow = (m: MealRow) => ({
    sku: m.sku,
    name: m.name,
    price_usd: m.usd,
    calories: m.cal,
    protein_g: m.protein,
  });

  // 1. Reschedule a meeting into a free slot. REST gets the usual CRUD tools *and*, as a
  //    separate row, an outcome-level endpoint, so the protocol isn't credited for API design.
  {
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
    const intentArgs = {
      service: 'calendar.example',
      capability: 'calendar.reschedule',
      params: { event: '1:1 Ana', day: DAY },
      auto: true,
    };
    const r = await cal.intent('calendar.reschedule', intentArgs.params, {
      auto: true,
    });

    if (r.kind !== 'RECEIPT') {
      throw new Error(r.lens);
    }

    await cal.undo(r.receipt.id); // keep data identical across tasks

    const yea = {
      calls: [
        {
          args: { name: 'yea_intent', arguments: intentArgs },
          result: r.lens,
        },
      ],
    };

    out.push({
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
    });
    out.push({
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
    });
  }

  // 2. Find vegan meals under 700 kcal and order four.
  {
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
      Math.round(lines.reduce((s, l) => s + l.unit_price * 100 * l.qty, 0)) /
      100;
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
    const askArgs = {
      service: 'shop.example',
      capability: 'shop.search',
      params: { tag: 'vegan', max_cal: 700 },
    };
    const a = await sh.ask('shop.search', askArgs.params, { budget: 1500 });
    const intentArgs = {
      service: 'shop.example',
      capability: 'shop.order',
      params: { items, deliver: DAY },
      auto: true,
    };
    const r = await sh.intent('shop.order', intentArgs.params, { auto: true });

    if (r.kind !== 'RECEIPT') {
      throw new Error(r.lens);
    }

    out.push({
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
      yea: {
        calls: [
          { args: { name: 'yea_ask', arguments: askArgs }, result: a.lens },
          {
            args: { name: 'yea_intent', arguments: intentArgs },
            result: r.lens,
          },
        ],
      },
    });
  }

  // 3. Read the whole 60-item menu (same content both ways; pure encoding cost).
  {
    const all = await data<MealRow[]>(sh, 'shop.search', {});
    const a = await sh.ask('shop.search', {}, { budget: 1e6 });

    out.push({
      name: 'Read the full 60-item menu',
      rest: (J) => ({
        calls: [
          {
            args: { name: 'search_meals', arguments: {} },
            result: J(all.map(menuRow)),
          },
        ],
      }),
      yea: {
        calls: [
          {
            args: {
              name: 'yea_ask',
              arguments: {
                service: 'shop.example',
                capability: 'shop.search',
                params: {},
              },
            },
            result: a.lens,
          },
        ],
      },
    });
  }

  // 4. Skim the menu: YEA with an 800-token budget, REST with `limit` set to the same
  //    number of items YEA returned. Same items both ways; YEA also says what's left.
  {
    const all = await data<MealRow[]>(sh, 'shop.search', {});
    const a = await sh.ask('shop.search', {}, { budget: 800 });
    const shown = (a as { data: unknown[] }).data.length;

    out.push({
      name: `Skim the menu (first ${shown} items: REST limit=${shown}, YEA budget=800)`,
      rest: (J) => ({
        calls: [
          {
            args: { name: 'search_meals', arguments: { limit: shown } },
            result: J(all.slice(0, shown).map(menuRow)),
          },
        ],
      }),
      yea: {
        calls: [
          {
            args: {
              name: 'yea_ask',
              arguments: {
                service: 'shop.example',
                capability: 'shop.search',
                params: {},
                budget: 800,
              },
            },
            result: a.lens,
          },
        ],
      },
    });
  }

  return out;
}

/** What the model pays: every turn re-reads tool definitions + the conversation so far. */
function cost(defs: string, run: Run) {
  const d = tok(defs);
  let history = 0,
    cumulative = 0,
    read = 0;

  for (const c of run.calls) {
    cumulative += d + history; // input tokens for the turn that emits this call

    const call = tok(JSON.stringify(c.args)),
      res = tok(c.result);

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
const n = (x: number) => x.toLocaleString('en-US');
const minJ = (v: unknown) => JSON.stringify(v),
  prettyJ = (v: unknown) => JSON.stringify(v, null, 2);

log(`# YEA vs REST-style MCP — token benchmark\n`);
log(
  `Tokenizer: o200k_base (gpt-tokenizer). Claude's tokenizer differs; the ratios are what matter. Both sides serve the same data. Ids are seeded, so runs are reproducible.\n`,
);
log(
  `**Total input** counts what you pay for: each model turn re-reads the tool definitions plus the conversation so far (calls and results), and there's one final turn to answer.\n`,
);
log(
  `Tool definitions in context every turn: REST MCP **${tok(restDefs)}** tokens (${REST_TOOLS.length} tools) vs YEA **${tok(yeaDefs)}** (${YEA_TOOLS.length} generic tools + service briefs).\n`,
);

const T = await tasks();

log(
  `| Task | Calls (REST → YEA) | Total input: REST minified JSON | REST pretty JSON | YEA | Saved vs minified | vs pretty |`,
);
log(`|---|---|---|---|---|---|---|`);

let SM = 0,
  SP = 0,
  SX = 0;

for (const t of T) {
  const m = cost(restDefs, t.rest(minJ)),
    pr = cost(restDefs, t.rest(prettyJ)),
    px = cost(yeaDefs, t.yea);

  if (!t.name.includes('outcome-level')) {
    SM += m.cumulative;
    SP += pr.cumulative;
    SX += px.cumulative;
  }

  log(
    `| ${t.name} | ${m.calls} → ${px.calls} | ${n(m.cumulative)} | ${n(pr.cumulative)} | ${n(px.cumulative)} | **${pct(m.cumulative, px.cumulative)}** | ${pct(pr.cumulative, px.cumulative)} |`,
  );
}

log(
  `| **All tasks** (CRUD reschedule row) | | ${n(SM)} | ${n(SP)} | ${n(SX)} | **${pct(SM, SX)}** | ${pct(SP, SX)} |\n`,
);
log(
  `Result tokens read, per task (minified REST → YEA): ${T.map((t) => `${cost(restDefs, t.rest(minJ)).read} → ${cost(yeaDefs, t.yea).read}`).join(' · ')}\n`,
);

log(`## What the model actually reads\n`);

const cr = T[0];

log(
  `### Reschedule, REST CRUD (3 calls, pretty JSON)\n\n\`\`\`json\n${cr
    .rest(prettyJ)
    .calls.map((c) => c.result)
    .join('\n\n')}\n\`\`\`\n`,
);
log(
  `### Reschedule, YEA (1 call, auto-commit)\n\n\`\`\`\n${cr.yea.calls.map((c) => c.result).join('\n\n')}\n\`\`\`\n`,
);
log(
  `What the tokens don't show: the YEA agent acted only because the principal's grant allows low-risk, undoable changes, and it got back exactly what happened with a 24h undo window. In the auto-commit case the *service* chose the slot (the first free one), just like the REST outcome endpoint. An agent that wants to choose omits \`auto\` and gets three proposals instead.`,
);

writeFileSync(
  new URL('./RESULTS.md', import.meta.url),
  `${lines.join('\n')}\n`,
);
