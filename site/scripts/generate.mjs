/**
 * Build-time files generated from the repo, so they never drift:
 *   .vitepress/generated/cli-help.txt   the CLI's own help text (ts/src/cli.ts help)
 *   public/llms.txt, public/llms-full.txt   for LLMs and agents (https://llmstxt.org)
 */
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
// The region markers VitePress's `<<<` import understands (TS/JS `// #region x`, Python
// `# region x`, HTML `<!-- #region x -->`), so a region reads here as it does on the page. A
// whole-file import drops the markers too, which the page keeps.
const MARKER =
  /^\s*(?:\/\/ ?#?|# ?|<!-- #?)(end)?region ([\w*-]+)(?: -->)?\s*$/i;
const LANG = {
  ts: 'ts',
  mjs: 'js',
  js: 'js',
  py: 'python',
  json: 'json',
  sh: 'sh',
  md: 'md',
};

/**
 * The lines of `text` inside region `name` (its first occurrence, as VitePress takes), or all of
 * them when `name` is empty; marker lines dropped.
 */
function snippet(text, name) {
  const lines = text.replace(/\n$/, '').split('\n');
  let inside = !name;
  let done = false;
  const kept = [];

  for (const line of lines) {
    const m = line.match(MARKER);

    if (m) {
      if (m[2] === name && !done) {
        inside = !m[1];
        done = Boolean(m[1]);
      }

      continue;
    }

    if (inside) {
      kept.push(line);
    }
  }

  if (name && !kept.length) {
    throw new Error(`no region ${name}`);
  }

  // Region bodies are often indented (a function body): drop the common indent.
  const indent = Math.min(
    ...kept.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length),
  );

  return kept
    .map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
    .join('\n')
    .trim();
}

/** Each `<<< path#region` line in page `p` replaced by that code, fenced, as VitePress shows it. */
function expandSnippets(p, md) {
  const dir = new URL(p.replace(/[^/]*$/, ''), root);

  return md.replace(
    /^<<< (\S+?)(?:#([\w*-]+))?(?:\s*\{([^}]*)\})?(?:\s*\[[^\]]*\])?\s*$/gm,
    (_all, file, name, lang) => {
      const url = file.startsWith('@/')
        ? new URL(file.slice(2), new URL('site/', root))
        : new URL(file, dir);
      const ext = file.split('.').pop();

      const fence = lang?.trim().split(/\s/)[0] || LANG[ext] || '';

      return `\`\`\`${fence}\n${snippet(readFileSync(url, 'utf8'), name)}\n\`\`\``;
    },
  );
}

const page = (p) =>
  expandSnippets(
    p,
    read(p)
      .replace(/^---[\s\S]*?---\n/, '')
      .replace(/^<!--@include:.*-->$/gm, '')
      .trim(),
  );
const readme = read('README.md');

const pages = [
  [
    'Add YEA to your MCP server (TypeScript)',
    '/guide/mcp-typescript',
    'Guard a tool you already have, make it undoable, let safe things run on their own: @yea-protocol/mcp',
  ],
  [
    'Add YEA to your MCP server (Python)',
    '/guide/mcp-python',
    'The same, for the official Python MCP SDK and FastMCP: yea-mcp',
  ],
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
    'How the policy works',
    '/guide/policy',
    'What a signed policy limits, and what happens past it',
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
    ...['mcp-typescript', 'mcp-python'].map((p) =>
      page(`site/guide/${p}.md`).replace(/^# /, '## '),
    ),
    `## Quickstart\n\n${region(readme, 'quickstart')}`,
    `## Use it from Claude Code and other MCP clients\n\n${region(readme, 'claude-code')}`,
    `## CLI reference\n\n\`\`\`\n${help}\n\`\`\``,
    ...['intents', 'policy', 'grants', 'budgets', 'lens', 'security'].map((p) =>
      page(`site/guide/${p}.md`).replace(/^# /, '## '),
    ),
    `## Wrap any REST API\n\n${region(readme, 'openapi')}`,
    `## Live-agent evaluation\n\n${read('bench/agent-eval/RESULTS.md').replace(/^# .*\n/, '')}\n\n### Prompt-injection condition\n\n${read('bench/agent-eval/RESULTS-injection.md').replace(/^# .*\n/, '')}`,
    `## Specification\n\n${read('SPEC.md').replace(/^# .*\n/, '')}`,
  ].join('\n\n---\n\n')}\n`,
);
console.log('generated cli-help.txt, llms.txt, llms-full.txt');
