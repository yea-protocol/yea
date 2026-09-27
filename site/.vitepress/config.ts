import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

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
  appearance: 'dark',
  // Included repo files (SPEC.md, design.md, …) link to each other with repo-relative paths.
  ignoreDeadLinks: [
    /^\.\.?\//,
    /^\/(ts|python|examples|bench|conformance)\b/,
    /RESULTS/,
  ],
  head: [
    [
      'link',
      { rel: 'icon', type: 'image/svg+xml', href: '/yea/brand/mark.svg' },
    ],
    ['meta', { name: 'theme-color', content: '#0B0D12' }],
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
    logo: { light: '/brand/mark.svg', dark: '/brand/mark.svg', alt: 'YEA' },
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
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark-dimmed' },
    // GitHub-style slugs, so anchors in the repo's markdown work here too.
    anchor: { slugify: githubSlug },
    config(md) {
      // GitHub-style task lists: "- [ ] item" renders as a checkbox readers can tick.
      md.core.ruler.after('inline', 'task-lists', (state) => {
        const toks = state.tokens;

        for (let i = 2; i < toks.length; i++) {
          const children = toks[i].children ?? [];
          const first = children[0];

          if (
            toks[i].type !== 'inline' ||
            toks[i - 2].type !== 'list_item_open' ||
            first?.type !== 'text'
          ) {
            continue;
          }

          const m = /^\[( |x)\] /i.exec(first.content);

          if (!m) {
            continue;
          }

          first.content = first.content.slice(4);

          const box = new state.Token('html_inline', '', 0);

          box.content = `<input type="checkbox" class="task-list-item-checkbox"${m[1] === ' ' ? '' : ' checked'}> `;
          children.unshift(box);
          toks[i - 2].attrJoin('class', 'task-list-item');
        }
      });
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
  'README.md': '/',
};

/** Map a repo-relative link in included markdown to a site page, or to GitHub. */
function repoLink(href: string): string {
  if (/^([a-z]+:|\/|#)/i.test(href)) {
    return href;
  }

  const [path, hash] = href.split('#');

  if (
    !/\.md$|^(\.\.\/)*(ts|python|examples|bench|conformance|docs|site|deploy)\b|\.(ts|py|json|svg|txt)$/.test(
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
        { text: 'Why YEA', link: '/why' },
        { text: 'Quickstart', link: '/guide/quickstart' },
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
