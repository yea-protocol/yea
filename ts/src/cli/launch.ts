/** Commands that launch something: the demo, the example services and bridges. */
import { principalKey } from '../home.js';
import { DEFAULT_PORT, listen, serveHttp } from '../node.js';
import { command, type Flags, UsageError, type Values } from './command.js';
import { die } from './shared.js';

/** Where a local service listens. */
const LISTEN_FLAGS = {
  port: { type: 'string', value: 'port', help: 'the port (default 7447)' },
  host: {
    type: 'string',
    value: 'host',
    help: 'the address to listen on, such as 0.0.0.0 in a container (default 127.0.0.1)',
  },
} as const satisfies Flags;

/** Principals whose grants a local service trusts: YEA_TRUST, else the principal key here. */
async function trustedPrincipals(): Promise<string[]> {
  const trust = (process.env.YEA_TRUST ?? '').split(',').filter(Boolean);
  const p = await principalKey();

  if (p && !trust.length) {
    trust.push(p.public);
  }

  return trust;
}

// ---- try it ----

export const cmdTestDrive = command({
  summary:
    'Watch a real Claude model use YEA live (needs an Anthropic API key; runs from @yea-protocol/cli).',
  usage: 'test-drive [<task> …] [flags]',
  flags: {
    model: {
      type: 'string',
      value: 'model',
      help: 'the Claude model to drive (default claude-opus-5)',
    },
  },
  example: 'yea test-drive "move my 3pm with Ana to tomorrow"',
  // Overridden by @yea-protocol/cli, which runs it: it drives the bridge, which the SDK can't load.
  run: async () =>
    die(
      'yea test-drive runs from @yea-protocol/cli: npx @yea-protocol/cli test-drive',
    ),
});

export const cmdDemo = command({
  summary:
    'A narrated end-to-end demo: two services, consent, undo and sub-agents. No API key needed.',
  usage: 'demo',
  flags: {},
  example: 'yea demo',
  run: demo,
});

async function demo() {
  const { runDemo } = await import('../examples/demo.js');

  await runDemo();
  process.exit(0);
}

export const cmdExamples = command({
  summary:
    'Serve the example calendar (on the port), shop (port + 2) and billing (port + 4), trusting your principal.',
  usage: 'examples [flags]',
  flags: LISTEN_FLAGS,
  example: 'yea examples --port 7447',
  run: (_args, o) => examples(o),
});

async function examples(o: Values<typeof LISTEN_FLAGS>) {
  const { calendar, shop, billing } = await import('../examples/index.js');
  const trust = await trustedPrincipals();
  const port = Number(o.port ?? DEFAULT_PORT);

  await listen(calendar({ trust }), { port, host: o.host });
  await listen(shop({ trust }), { port: port + 2, host: o.host });
  await listen(billing({ trust }), { port: port + 4, host: o.host });
  console.error(
    `✓ calendar yea://127.0.0.1:${port} · shop yea://127.0.0.1:${port + 2} · billing yea://127.0.0.1:${port + 4} · trusting ${trust.length} principal(s)${trust.length ? '' : ' (run yea init first to commit anything)'}\n  try: yea do yea://127.0.0.1:${port} calendar.reschedule event=Ana`,
  );
}

// ---- bridges ----

const OPENAPI_FLAGS = {
  base: {
    type: 'string',
    value: 'url',
    help: "the API's base URL, if not the spec's",
  },
  header: {
    type: 'string',
    multiple: true,
    value: 'K: V',
    help: 'a header for every upstream call, such as a credential (never shown to the model)',
  },
  id: { type: 'string', value: 'id', help: "the service's id" },
  prefix: {
    type: 'string',
    value: 'prefix',
    help: 'the prefix of every capability name',
  },
  ...LISTEN_FLAGS,
  http: {
    type: 'string',
    value: 'port',
    help: 'also serve YEA over HTTP on this port',
  },
  preset: {
    type: 'string',
    value: 'github|petstore',
    help: 'a curated API: its spec, operations, risks and credentials',
  },
} as const satisfies Flags;

export const cmdOpenapi = command({
  summary:
    'Serve a REST API as a YEA service, from its OpenAPI spec: reads become asks, writes become proposals.',
  usage: 'openapi [<spec.json|url>] [flags]',
  flags: OPENAPI_FLAGS,
  example: 'yea openapi --preset petstore',
  run: openapi,
});

async function openapi(rest: string[], o: Values<typeof OPENAPI_FLAGS>) {
  const { fromOpenAPI, loadOpenAPI } = await import('../openapi.js');
  const { PRESETS, presetOptions } = await import('../presets.js');
  const names = Object.keys(PRESETS);
  const preset = o.preset
    ? (PRESETS[o.preset] ?? usageError(`unknown preset ${o.preset}`, names))
    : null;

  for (const e of preset?.env ?? []) {
    if (!process.env[e]) {
      console.error(
        `note: ${e} is not set; ${o.preset} will only do what works without it`,
      );
    }
  }

  const spec = await loadOpenAPI(
    preset?.spec ??
      rest[0] ??
      usageError('missing <spec.json|url> or --preset', names),
  );
  const headers = {
    ...(preset ? presetOptions(preset).headers : {}),
    ...headerFlags(o),
  };
  const trust = await trustedPrincipals();
  const svc = fromOpenAPI(spec, {
    ...(preset ? presetOptions(preset) : {}),
    ...(o.base ? { baseUrl: o.base } : {}),
    ...(o.id ? { id: o.id } : {}),
    ...(o.prefix ? { prefix: o.prefix } : {}),
    headers,
    trust,
  });
  const port = Number(o.port ?? DEFAULT_PORT);

  await listen(svc, { port, host: o.host });

  if (o.http) {
    await serveHttp(svc, { port: Number(o.http), host: o.host });
  }

  const count = (kind: string) =>
    svc.capabilities.filter((c) => c.kind === kind).length;

  console.error(
    `✓ ${svc.id}: ${svc.capabilities.length} capabilities (${count('ask')} ask, ${count('intent')} intent)\n  yea://127.0.0.1:${port}${o.http ? `  ·  http://127.0.0.1:${o.http}/yea` : ''}\n  trusting ${trust.length} principal(s) for writes\n  try: yea hello yea://127.0.0.1:${port}`,
  );
}

/** Throw a `UsageError` for `yea openapi`, with the presets as its hint. */
function usageError(message: string, presets: string[]): never {
  throw new UsageError(message, `presets: ${presets.join(', ')}`);
}

/** --header "K: V" flags as a header map. */
const headerFlags = (o: { header?: string[] }) =>
  Object.fromEntries(
    (o.header ?? []).map((h) => [
      h.slice(0, h.indexOf(':')).trim(),
      h.slice(h.indexOf(':') + 1).trim(),
    ]),
  );

export const cmdMcp = command({
  summary:
    'Run the MCP server (stdio) your AI tools use: one tool per capability. With no URLs, it serves yea services.',
  usage: 'mcp [<url> …] [flags]',
  flags: {
    tools: {
      type: 'string',
      value: 'generic|per-capability',
      choices: ['generic', 'per-capability'],
      help: 'force one tool mode (default: per capability, generic past 25)',
    },
    budget: {
      type: 'string',
      value: 'tokens',
      help: 'the default token budget for replies',
    },
    name: {
      type: 'string',
      value: 'name',
      help: 'the agent name services see (default yea-mcp)',
    },
    'approve-here': {
      type: 'boolean',
      help: 'approve in the AI tool (not available yet; use yea approve)',
    },
  },
  example: 'yea mcp yea://127.0.0.1:7447',
  // Overridden by @yea-protocol/cli, which runs it: it depends on @yea-protocol/mcp; the SDK can't.
  run: async () =>
    die(
      'yea mcp runs from @yea-protocol/cli: npx -y @yea-protocol/cli mcp [<url> …]',
    ),
});
