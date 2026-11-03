/**
 * Where the tokens of `yea mcp`'s tool definitions go, part by part, counted as bench/run.ts
 * counts them: each tool's name, description and inputSchema as JSON, then the instructions, in
 * o200k_base. A part's figure is what leaving it out saves; "names and JSON" is the rest, so the
 * rows sum to the total. `npm run bench:definitions` runs it (and `npm run bench` ends with it).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { bridge } from '@yea-protocol/mcp/bridge';
import { Client, issueGrant, keyPair, local } from '@yea-protocol/sdk';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { calendar } from '../examples/calendar.ts';
import { shop } from '../examples/shop.ts';

/** A tool as a model API takes it. */
interface ModelTool {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}

/** What the bridge puts in the model's context every turn. */
interface Defs {
  tools: ModelTool[];
  instructions: string;
}

/** One part of the definitions, and the definitions without it. */
interface Part {
  label: string;
  without: (d: Defs) => Defs;
}

const JOB_FIELDS = ['goal', 'preview', 'proposal'];

/** A capability tool's description ends in its service, in parentheses. */
const SUFFIX = / \([^()]*\)$/;

const tok = (s: string) => encode(s).length;
const count = (d: Defs) => tok(`${JSON.stringify(d.tools)}\n${d.instructions}`);
const isUtility = (t: ModelTool) => t.name.startsWith('yea_');

/** The definitions `bridge()` serves with `yea mcp`'s defaults over the example services. */
async function served(): Promise<Defs> {
  const principal = await keyPair();
  const agent = await keyPair();
  const grant = await issueGrant({ principal, to: agent.public });
  const as = { key: agent.seed, grants: [grant] };
  const trust = [principal.public];
  const factory = await bridge([
    { client: new Client(local(calendar({ trust })), as), url: 'calendar' },
    { client: new Client(local(shop({ trust })), as), url: 'shop' },
  ]);
  const client = new McpClient({ name: 'yea-bench', version: '0.0.0' });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();

  await factory().connect(serverEnd);
  await client.connect(clientEnd);

  const { tools } = await client.listTools();

  return {
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    instructions: client.getInstructions() ?? '',
  };
}

/** `d` with each capability tool (not the `yea_` utilities) changed by `f`. */
const onCapabilities =
  (f: (t: ModelTool) => ModelTool) =>
  (d: Defs): Defs => ({
    ...d,
    tools: d.tools.map((t) => (isUtility(t) ? t : f(t))),
  });

/** A tool with only the schema properties `keep` names, dropping what's left empty. */
function keepProperties(t: ModelTool, keep: (name: string) => boolean) {
  const { properties = {}, required = [], ...rest } = t.inputSchema;
  const kept = Object.entries(properties).filter(([name]) => keep(name));
  const stillRequired = required.filter(keep);

  return {
    ...t,
    inputSchema: {
      ...rest,
      ...(kept.length ? { properties: Object.fromEntries(kept) } : {}),
      ...(stillRequired.length ? { required: stillRequired } : {}),
    },
  };
}

/** The parts of the capability tools: descriptions, params and the job fields. */
function capabilityParts(d: Defs): Part[] {
  const n = d.tools.filter((t) => !isUtility(t)).length;
  const description = (f: (s: string) => string) =>
    onCapabilities((t) => ({ ...t, description: f(t.description ?? '') }));

  return [
    {
      label: `capability summaries (${n} tools)`,
      without: description((s) => s.match(SUFFIX)?.[0] ?? ''),
    },
    {
      label: `the "(… service)" after each summary (${n})`,
      without: description((s) => s.replace(SUFFIX, '')),
    },
    {
      label: `capability params (${n})`,
      without: onCapabilities((t) =>
        keepProperties(t, (k) => JOB_FIELDS.includes(k)),
      ),
    },
    ...JOB_FIELDS.map((field) => ({
      label: `job field \`${field}\` (${d.tools.filter((t) => t.inputSchema.properties?.[field]).length})`,
      without: onCapabilities((t) => keepProperties(t, (k) => k !== field)),
    })),
  ];
}

/** Each `yea_` utility tool, whole. */
const utilityParts = (d: Defs): Part[] =>
  d.tools.filter(isUtility).map((u) => ({
    label: `tool \`${u.name}\``,
    without: (e) => ({ ...e, tools: e.tools.filter((t) => t.name !== u.name) }),
  }));

/**
 * The instructions: each line of the header, then the service notes. A blank line ends the
 * header in either tool mode (a generic service's note is a Lens list, not a `# ` heading).
 */
function instructionParts(d: Defs): Part[] {
  const lines = d.instructions.split('\n');
  const blank = lines.indexOf('');
  const header = lines.slice(0, blank === -1 ? lines.length : blank);
  const lineParts = header.map((line, i) => ({
    label: `instructions: "${line.slice(0, 40)}…"`,
    without: (e: Defs) => ({
      ...e,
      instructions: lines.filter((_, j) => j !== i).join('\n'),
    }),
  }));

  return [
    ...lineParts,
    {
      label: 'instructions: the service notes',
      without: (e) => ({ ...e, instructions: header.join('\n').trim() }),
    },
  ];
}

/** Each part's tokens, then the rest as "names and JSON", then the total. */
function table(d: Defs): string {
  const total = count(d);
  const parts = [
    ...capabilityParts(d),
    ...utilityParts(d),
    ...instructionParts(d),
  ];
  const rows = parts.map((p) => [p.label, total - count(p.without(d))]);
  const rest = total - rows.reduce((sum, [, n]) => sum + Number(n), 0);

  return [
    '| Part | Tokens |',
    '|---|---|',
    ...rows.map(([label, n]) => `| ${label} | ${n} |`),
    `| tool names and JSON | ${rest} |`,
    `| **Total** | **${total}** |`,
  ].join('\n');
}

const home = mkdtempSync(join(tmpdir(), 'yea-bench-'));

process.env.YEA_HOME = home;
console.log(table(await served()));
rmSync(home, { recursive: true, force: true });
process.exit(0);
