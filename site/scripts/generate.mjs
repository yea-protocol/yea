// Build-time files generated from the repo, so they never drift:
//   .vitepress/generated/cli-help.txt   the CLI's own help text (ts/src/cli.ts help)
//   public/llms.txt, public/llms-full.txt   for LLMs and agents (https://llmstxt.org)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const out = (p, s) => {
  const u = new URL(p, new URL('../', import.meta.url));

  mkdirSync(new URL('./', u), { recursive: true });
  writeFileSync(u, s);
};
const SITE = 'https://yea-protocol.github.io/yea';

const cli = read('ts/src/cli.ts');
const HELP_START = 'const help = () => `';
const help = cli
  .slice(
    cli.indexOf(HELP_START) + HELP_START.length,
    cli.indexOf('`;', cli.indexOf(HELP_START)),
  )
  .replace(/\$\{home\(\)\}/g, '~/.yea');

out('.vitepress/generated/cli-help.txt', `${help}\n`);

const region = (md, name) => {
  const m = md.match(
    new RegExp(
      `<!-- #region ${name} -->([\\s\\S]*?)<!-- #endregion ${name} -->`,
    ),
  );

  return m ? m[1].trim() : '';
};
const page = (p) =>
  read(p)
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/^<!--@include:.*-->$/gm, '')
    .trim();
const readme = read('README.md');

const pages = [
  [
    'Why YEA',
    '/why',
    'The problem with agents acting through APIs built for code, and the five ideas behind YEA',
  ],
  [
    'Quickstart',
    '/guide/quickstart',
    'Install, run the demo, build a service, act as an agent, delegate',
  ],
  [
    'Integrations',
    '/guide/integrations',
    'Connect YEA to Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI, Zed, Windsurf and Hermes Agent',
  ],
  [
    'Intents and proposals',
    '/guide/intents',
    'INTENT, PROPOSALS, COMMIT, UNDO, and policy-gated auto-commit',
  ],
  [
    'Grants and consent',
    '/guide/grants',
    'Signed delegation chains, caveats, proofs, and one-shot consent bound to a proposal hash',
  ],
  [
    'Budgets and EXPAND',
    '/guide/budgets',
    'Token budgets, elision rules and the shared token estimate',
  ],
  ['Lens', '/guide/lens', 'The canonical text rendering models read'],
  [
    'From REST to YEA',
    '/guide/service-design',
    'Translate a REST API into a YEA service: the concept mapping, five steps, and a full Stripe-backed example',
  ],
  [
    'Build a service',
    '/guide/build-a-service',
    'Capabilities, plans, the compact param schema and teaching errors',
  ],
  [
    'Wrap any REST API',
    '/guide/openapi',
    'yea openapi: GETs become ASKs, writes become proposals',
  ],
  [
    'Security model',
    '/guide/security',
    'Key isolation, what each mechanism stops, and known limits',
  ],
  [
    'Troubleshooting',
    '/guide/troubleshooting',
    'yea doctor and common problems',
  ],
  ['CLI reference', '/reference/cli', 'Every yea command'],
  ['Specification', '/reference/spec', 'The YEA v1 wire protocol'],
];
const optional = [
  ['Playground', '/playground', 'Try the protocol in the browser'],
  ['Design decisions', '/reference/design', 'Why YEA is built this way'],
  [
    'Live-agent evaluation',
    '/benchmark/live',
    'A real model through REST-MCP vs YEA: cost, success and rule violations, including prompt injection',
  ],
  [
    'Payload benchmark',
    '/reference/benchmark',
    'Reply sizes versus a REST-style MCP server, measured without a model',
  ],
  [
    'A real Claude session',
    '/reference/claude-session',
    'Unedited transcript through the MCP bridge',
  ],
  ['Python', '/guide/python', 'The Python implementation'],
];
const list = (xs) =>
  xs.map(([t, p, d]) => `- [${t}](${SITE}${p}): ${d}`).join('\n');

out(
  'public/llms.txt',
  `# YEA

> YEA is an open protocol for AI agents acting on behalf of people. Agents send an INTENT; services reply with proposals whose effects, what they use, risk and undo window are listed up front; nothing changes until COMMIT, which carries a grant signed by the human's key. The human's policy decides what can commit without asking, and anything beyond it needs a one-shot consent bound to the exact proposal. Replies fit a token budget and are rendered as Lens, a compact text format for models. Implementations: TypeScript (reference) and Python. MCP clients use YEA through the bridge: \`npx -y @yea-protocol/cli mcp\`.

Full text of the key docs, the CLI and the spec in one file: ${SITE}/llms-full.txt

## Docs

${list(pages)}

## Optional

${list(optional)}
`,
);

out(
  'public/llms-full.txt',
  `${[
    `# YEA\n\nSource: https://github.com/yea-protocol/yea · Docs: ${SITE}/`,
    `## Quickstart\n\n${region(readme, 'quickstart')}`,
    `## Use it from Claude Code and other MCP clients\n\n${region(readme, 'claude-code')}`,
    `## CLI reference\n\n\`\`\`\n${help}\n\`\`\``,
    ...['intents', 'grants', 'budgets', 'lens', 'security'].map((p) =>
      page(`site/guide/${p}.md`).replace(/^# /, '## '),
    ),
    `## Wrap any REST API\n\n${region(readme, 'openapi')}`,
    `## Live-agent evaluation\n\n${read('bench/agent-eval/RESULTS.md').replace(/^# .*\n/, '')}\n\n### Prompt-injection condition\n\n${read('bench/agent-eval/RESULTS-injection.md').replace(/^# .*\n/, '')}`,
    `## Specification\n\n${read('SPEC.md').replace(/^# .*\n/, '')}`,
  ].join('\n\n---\n\n')}\n`,
);
console.log('generated cli-help.txt, llms.txt, llms-full.txt');
