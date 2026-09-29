/**
 * VitePress configuration for the docs site: head tags, navigation and
 * sidebar, Markdown and Vite options.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { appearanceMigration, fontPreloads, themeColor } from './head';
import { lensFence } from './lens-fence';
import { headingOrder, taskLists } from './markdown-rules';
import { paperLight } from './shiki-light';

const repo = 'https://github.com/yea-protocol/yea';
const site = 'https://yea-protocol.github.io/yea/';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: '/yea/',
  title: 'YEA',
  description:
    'An open protocol for AI agents acting on behalf of people: intents, proposals, commits and undo, with signed delegation and token budgets.',
  cleanUrls: true,
  srcExclude: ['drafts/**'],
  lastUpdated: true,
  // Follow the reader's OS theme. Pages are designed light first; both themes meet WCAG AA.
  appearance: true,
  // Included repo files (SPEC.md, design.md, …) link to each other with repo-relative paths.
  ignoreDeadLinks: [
    /^\.\.?\//,
    /^\/(ts|python|examples|bench|conformance)\b/,
    /RESULTS/,
  ],
  head: [
    // First, so it runs before VitePress's check-dark-mode script reads the stored appearance.
    appearanceMigration,
    [
      'link',
      { rel: 'icon', type: 'image/svg+xml', href: '/yea/brand/mark.svg' },
    ],
    themeColor,
    ['meta', { property: 'og:type', content: 'website' }],
    [
      'meta',
      {
        property: 'og:title',
        content:
          'YEA (Your Explicit Approval): the open protocol for AI agents acting on behalf of people.',
      },
    ],
    [
      'meta',
      {
        property: 'og:description',
        content:
          "Agents state an intent. Services reply with proposals whose effects are listed up front. The human's policy decides what goes ahead.",
      },
    ],
    ['meta', { property: 'og:image', content: `${site}brand/social.png` }],
    ['meta', { property: 'og:url', content: site }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${site}brand/social.png` }],
  ],
  themeConfig: {
    // Decorative: the site title beside the mark already names it.
    logo: { light: '/brand/mark.svg', dark: '/brand/mark.svg', alt: '' },
    nav: [
      { text: 'Why YEA', link: '/why' },
      { text: 'Guide', link: '/guide/quickstart', activeMatch: '/guide/' },
      { text: 'Playground', link: '/playground' },
      { text: 'Spec', link: '/reference/spec', activeMatch: '/reference/' },
    ],
    sidebar: {
      '/guide/': sidebar(),
      '/reference/': sidebar(),
      '/why': sidebar(),
      '/benchmark/': sidebar(),
    },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: {
      pattern: `${repo}/edit/main/site/:path`,
      text: 'Edit this page on GitHub',
    },
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: {
      message: 'Apache-2.0. The spec is free to implement.',
      copyright: `<a href="${repo}">github.com/yea-protocol/yea</a>`,
    },
  },
  // Preload the fonts the first paint needs, so it doesn't swap faces.
  // VitePress renders the appearance switch with an empty title and names it only on the client:
  // name it in the static HTML too, so it isn't an unnamed control before hydration or without JS.
  transformHtml: (html) =>
    html.replaceAll(
      'class="VPSwitch VPSwitchAppearance" type="button" role="switch" title ',
      'class="VPSwitch VPSwitchAppearance" type="button" role="switch" aria-label="Dark theme" title ',
    ),
  transformHead: ({ assets, pageData }) =>
    fontPreloads(assets, pageData.relativePath),
  markdown: {
    theme: { light: paperLight, dark: 'github-dark-dimmed' },
    // GitHub-style slugs, so anchors in the repo's markdown work here too.
    anchor: { slugify: githubSlug },
    // Lens lines in plain-text blocks, coloured by protocol state.
    codeTransformers: [lensFence],
    config(md) {
      // Task lists with labelled checkboxes, and heading levels that never skip.
      taskLists(md);
      headingOrder(md);
      md.core.ruler.push('repo-links', (state) => {
        for (const tok of state.tokens) {
          for (const t of tok.children ?? []) {
            if (t.type !== 'link_open') {
              continue;
            }

            const href = t.attrGet('href');

            if (href) {
              t.attrSet('href', repoLink(href));
            }
          }
        }
      });
    },
  },
  vite: {
    resolve: {
      alias: [
        // The playground runs the real TypeScript core, straight from source.
        {
          find: /^@yea-protocol\/sdk$/,
          replacement: r('../../ts/src/index.ts'),
        },
        {
          find: /^@examples\/(.*)$/,
          replacement: r('../../ts/src/examples/$1'),
        },
      ],
    },
    server: { fs: { allow: [r('../..')] } },
  },
});

/** Site pages built from repo files, keyed by repo path. */
const PAGES: Record<string, string> = {
  'SPEC.md': '/reference/spec',
  'docs/design.md': '/reference/design',
  'docs/conventions.md': '/reference/conventions',
  'bench/RESULTS.md': '/reference/benchmark',
  'bench/agent-eval/README.md': '/benchmark/live',
  'bench/agent-eval/RESULTS.md': '/benchmark/live#results',
  'bench/agent-eval/RESULTS-injection.md':
    '/benchmark/live#prompt-injection-condition',
  'docs/claude-code-session.md': '/reference/claude-session',
  'python/README.md': '/guide/python',
  'docs/why.md': '/why',
  'deploy/demo/README.md': '/guide/hosted-demo',
  'connectors/stripe/README.md': '/guide/stripe',
  mcp: '/guide/mcp-typescript',
  'README.md': '/',
};

/** Map a repo-relative link in included markdown to a site page, or to GitHub. */
function repoLink(href: string): string {
  if (/^([a-z]+:|\/|#)/i.test(href)) {
    return href;
  }

  const [path, hash] = href.split('#');

  if (
    !/\.md$|^(\.\.\/)*(ts|python|examples|bench|conformance|docs|site|deploy|mcp|connectors)\b|\.(ts|py|json|svg|txt)$/.test(
      path,
    )
  ) {
    return href;
  }

  // Normalize against the repo root: included files live at the root, in docs/, python/ or bench/.
  const clean = path.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
  // Bare names like RESULTS.md only appear in bench/agent-eval's own files, so resolve those there first.
  const candidates = [
    clean,
    `bench/agent-eval/${clean}`,
    `docs/${clean}`,
    `python/${clean}`,
    `bench/${clean}`,
    `deploy/demo/${clean}`,
  ];
  const page = candidates.map((c) => PAGES[c]).find(Boolean);

  // VitePress's link renderer adds the base to internal links after this runs.
  if (page) {
    return page + (hash ? `#${hash}` : '');
  }

  return `${repo}/blob/main/${clean}${hash ? `#${hash}` : ''}`;
}

function githubSlug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function sidebar() {
  return [
    {
      text: 'Start',
      items: [
        {
          text: 'Add YEA to your MCP server (TypeScript)',
          link: '/guide/mcp-typescript',
        },
        {
          text: 'Add YEA to your MCP server (Python)',
          link: '/guide/mcp-python',
        },
        { text: 'Quickstart', link: '/guide/quickstart' },
        { text: 'Why YEA', link: '/why' },
        { text: 'Playground', link: '/playground' },
        { text: 'Test drive', link: '/guide/test-drive' },
        { text: 'Use it from Claude Code', link: '/guide/claude-code' },
        { text: 'Integrations', link: '/guide/integrations' },
        { text: 'Hosted demo', link: '/guide/hosted-demo' },
      ],
    },
    {
      text: 'Concepts',
      items: [
        { text: 'Intents and proposals', link: '/guide/intents' },
        { text: 'Grants and consent', link: '/guide/grants' },
        { text: 'Budgets and EXPAND', link: '/guide/budgets' },
        { text: 'Lens', link: '/guide/lens' },
      ],
    },
    {
      text: 'Build',
      items: [
        { text: 'From REST to YEA', link: '/guide/service-design' },
        { text: 'Build a service', link: '/guide/build-a-service' },
        { text: 'Stripe connector', link: '/guide/stripe' },
        { text: 'Wrap any REST API', link: '/guide/openapi' },
        { text: 'Docker', link: '/guide/docker' },
        { text: 'Python', link: '/guide/python' },
        { text: 'Security model', link: '/guide/security' },
        { text: 'Troubleshooting', link: '/guide/troubleshooting' },
      ],
    },
    {
      text: 'Reference',
      items: [
        { text: 'Specification', link: '/reference/spec' },
        { text: 'Conventions for uses', link: '/reference/conventions' },
        { text: 'CLI', link: '/reference/cli' },
        { text: 'Verified releases', link: '/reference/verified-releases' },
        { text: 'Design decisions', link: '/reference/design' },
        { text: 'Live-agent evaluation', link: '/benchmark/live' },
        { text: 'Payload benchmark', link: '/reference/benchmark' },
        { text: 'A real Claude session', link: '/reference/claude-session' },
        { text: 'FAQ', link: '/reference/faq' },
      ],
    },
  ];
}
