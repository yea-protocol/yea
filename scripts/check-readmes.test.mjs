/**
 * Tests for check-readmes.mjs: the repo's READMEs pass, every published package but the SDK has
 * a page, a snippet must match its region (`// #region` or Python's `# region`), every fenced
 * code block must be pinned however its fence is spelled, a broken marker is a problem line,
 * and a package page must install its package outside comments and banners, link its own guide
 * and SPEC (which must exist) absolutely, and have no relative link outside code.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pageProblems } from './check-readmes/page.mjs';
import { region, snippetProblems } from './check-readmes/snippets.mjs';
import { packageReadmes, readmeProblems } from './check-readmes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A temp folder holding `files` (path to text). */
function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'yea-readmes-'));

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  return root;
}

const PY = [
  '"""An example."""',
  '# region hello',
  'def hello():',
  '    print("hi")',
  '# endregion hello',
  '',
].join('\n');

/** A README whose one snippet, from ex.py#hello, is `code`. */
const pinned = (code) =>
  `# x\n\n<!-- snippet: ex.py#hello -->\n\`\`\`python\n${code}\n\`\`\`\n`;

/** The package the page fixtures are for: its name, its guide and its SPEC. */
const X = {
  name: '@yea-protocol/x',
  guide: 'x',
  spec: 'docs/framework/SPEC-x.md',
};

/** A package page for X that passes, with `extra` appended. */
const page = (extra = '') =>
  [
    '```sh',
    'npm i @yea-protocol/x zod@4',
    '```',
    '[Guide](https://yea-protocol.github.io/yea/guide/x) ·',
    '[spec](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-x.md#jobs)',
    extra,
  ].join('\n');

/** A repo holding X's guide and SPEC, so links to them aren't dead. */
const PAGES = repoWith({
  'site/guide/x.md': '# x\n',
  'docs/framework/SPEC-x.md': '# x\n',
});

/** X's page with `install` as its only shell block's text. */
const installing = (install) =>
  page().replace('npm i @yea-protocol/x zod@4', install);

test("the repo's READMEs pass", () => {
  assert.deepEqual(readmeProblems(ROOT), []);
});

test('every published package but the SDK has a page, named for what it installs', () => {
  const page = (readme, name, guide, spec) => ({ readme, name, guide, spec });

  assert.deepEqual(packageReadmes(ROOT), [
    page(
      'cli/README.md',
      '@yea-protocol/cli',
      'integrations',
      'docs/framework/SPEC-bridge.md',
    ),
    page(
      'mcp/README.md',
      '@yea-protocol/mcp',
      'mcp-typescript',
      'docs/framework/SPEC-mcp-ts.md',
    ),
    page(
      'connectors/stripe/README.md',
      '@yea-protocol/stripe',
      'stripe',
      'docs/framework/SPEC-connector-stripe.md',
    ),
    page('python/README.md', 'yea-sdk', 'python', 'SPEC.md'),
    page(
      'python/mcp/README.md',
      'yea-mcp',
      'mcp-python',
      'docs/framework/SPEC-mcp-py.md',
    ),
  ]);
});

test('a region is read with its comment style: # in Python and shell, // elsewhere', () => {
  const root = repoWith({
    'ex.py': PY,
    'ex.sh': '# region run\nyea demo\n# endregion run\n',
    'ex.ts': '  // #region a\n  const a = 1;\n  // #endregion a\n',
  });

  assert.equal(region(root, 'ex.py', 'hello'), 'def hello():\n    print("hi")');
  assert.equal(region(root, 'ex.sh', 'run'), 'yea demo');
  assert.equal(region(root, 'ex.ts', 'a'), 'const a = 1;');
  assert.equal(region(root, 'ex.ts', 'b'), undefined);
});

test('a snippet that drifts from its region fails', () => {
  const root = repoWith({ 'ex.py': PY });

  assert.deepEqual(
    snippetProblems(root, 'R.md', pinned('def hello():\n    print("hi")')),
    [],
  );
  assert.deepEqual(
    snippetProblems(root, 'R.md', pinned('def hello():\n    print("hello")')),
    [
      'R.md: the snippet from ex.py#hello differs from the file. Copy the region again.',
    ],
  );
});

test('a code block without a marker fails, and so does a README with none', () => {
  const root = repoWith({ 'ex.py': PY });
  const code = 'def hello():\n    print("hi")';

  assert.deepEqual(
    snippetProblems(root, 'R.md', `${pinned(code)}\n\`\`\`ts\nx()\n\`\`\`\n`),
    [
      'R.md: the code block at line 9 has no snippet marker; copy it from a tested file',
    ],
  );
  assert.deepEqual(snippetProblems(root, 'R.md', '```sh\nnpm i x\n```\n'), [
    'R.md: no snippet markers found; pin one from a tested file',
  ]);
});

test('a code block is found however its fence is spelled', () => {
  const root = repoWith({ 'ex.py': PY });
  const before = pinned('def hello():\n    print("hi")');
  const blocks = [
    ['```python3\nx()\n```', 9],
    ['```Python\nx()\n```', 9],
    ['```\nx()\n```', 9],
    ['~~~ts\nx()\n~~~', 9],
    ['```ts title=x\nx()\n```', 9],
    ['- step\n\n  ```ts\n  x()\n  ```', 11],
    ['> ```ts\n> x()\n> ```', 9],
  ];

  for (const [block, line] of blocks) {
    assert.deepEqual(
      snippetProblems(root, 'R.md', `${before}\n${block}\n`),
      [
        `R.md: the code block at line ${line} has no snippet marker; copy it from a tested file`,
      ],
      block,
    );
  }
});

test('a block runs to a fence of its own mark and length, or to the end', () => {
  const root = repoWith({ 'ex.py': PY });
  const before = pinned('def hello():\n    print("hi")');
  const one = [
    'R.md: the code block at line 9 has no snippet marker; copy it from a tested file',
  ];

  assert.deepEqual(
    snippetProblems(root, 'R.md', `${before}\n\`\`\`ts\nx()\n`),
    one,
  );
  assert.deepEqual(
    snippetProblems(root, 'R.md', `${before}\n\`\`\`ts\nx()\n~~~\n\`\`\`\n`),
    one,
  );
  assert.deepEqual(
    snippetProblems(
      root,
      'R.md',
      `${before}\n\`\`\`\`ts\nx()\n\`\`\`\n\`\`\`\`\n`,
    ),
    one,
  );
});

test('a README with Windows line endings reads the same', () => {
  const crlf = (text) => text.replaceAll('\n', '\r\n');
  const root = repoWith({ 'ex.py': crlf(PY) });

  assert.deepEqual(
    snippetProblems(
      root,
      'R.md',
      crlf(pinned('def hello():\n    print("hi")')),
    ),
    [],
  );
  assert.deepEqual(pageProblems(PAGES, 'R.md', X, crlf(page())), []);
});

test("only shell, config, output and diagram blocks needn't be pinned", () => {
  const root = repoWith({ 'ex.py': PY });
  const before = pinned('def hello():\n    print("hi")');
  const exempt = [
    '```sh',
    '```JSON',
    '```text no-lens',
    '```mermaid',
    '```toml',
  ];

  for (const fence of exempt) {
    assert.deepEqual(
      snippetProblems(root, 'R.md', `${before}\n${fence}\nx\n\`\`\`\n`),
      [],
      fence,
    );
  }

  assert.equal(
    snippetProblems(root, 'R.md', `${before}\n\`\`\`rb\nx\n\`\`\`\n`).length,
    1,
  );
});

test('a pinned block may sit under a list item', () => {
  const root = repoWith({ 'ex.py': PY });
  const md = [
    '- step',
    '',
    '  <!-- snippet: ex.py#hello -->',
    '  ```python',
    '  def hello():',
    '      print("hi")',
    '  ```',
  ].join('\n');

  assert.deepEqual(snippetProblems(root, 'R.md', md), []);
});

test('a marker naming a missing region or file, or with no block after it, is one line', () => {
  const root = repoWith({ 'ex.py': PY });
  const marked = (target, after = '```python\nx\n```') =>
    `# x\n<!-- snippet: ${target} -->\n${after}\n`;

  assert.deepEqual(snippetProblems(root, 'R.md', marked('ex.py#gone')), [
    'R.md: the marker at line 2 names ex.py#gone, but ex.py has no region gone',
  ]);
  assert.deepEqual(snippetProblems(root, 'R.md', marked('no.py#hello')), [
    'R.md: the marker at line 2 names no.py#hello, but there is no no.py',
  ]);
  assert.deepEqual(snippetProblems(root, 'R.md', marked('ex.py#hello', 'x')), [
    "R.md: the marker at line 2 isn't followed by a code block",
  ]);
  assert.deepEqual(
    snippetProblems(root, 'R.md', marked('ex.py#hello', '\n```python\nx\n```')),
    [
      "R.md: the marker at line 2 isn't followed by a code block",
      'R.md: the code block at line 4 has no snippet marker; copy it from a tested file',
    ],
  );
});

test('a package page installs its package and links its guide and SPEC absolutely', () => {
  assert.deepEqual(pageProblems(PAGES, 'R.md', X, page()), []);
  assert.deepEqual(
    pageProblems(PAGES, 'R.md', { ...X, name: '@yea-protocol/x-tra' }, page()),
    ['R.md: no shell block that installs @yea-protocol/x-tra'],
  );
  assert.deepEqual(
    pageProblems(
      PAGES,
      'R.md',
      { ...X, name: 'yea-mcp' },
      "```sh\nuv add 'yea-mcp[fastmcp]'\n```",
    ),
    [
      'R.md: no absolute link to its guide (https://yea-protocol.github.io/yea/guide/x)',
      'R.md: no absolute link to its SPEC (https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-x.md)',
    ],
  );
});

test("a link to another package's guide or SPEC isn't its own", () => {
  const others = [
    ['/guide/stripe)', 'SPEC-connector-stripe.md'],
    ['/guide/xyz)', 'SPEC-x.md.old'],
  ];

  for (const [guide, spec] of others) {
    const md = page()
      .replace('/guide/x)', guide)
      .replace('SPEC-x.md#jobs', spec);

    assert.deepEqual(pageProblems(PAGES, 'R.md', X, md), [
      'R.md: no absolute link to its guide (https://yea-protocol.github.io/yea/guide/x)',
      'R.md: no absolute link to its SPEC (https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-x.md)',
    ]);
  }
});

test("a guide or SPEC that isn't in the repo fails, since its link would be dead", () => {
  assert.deepEqual(pageProblems(repoWith({}), 'R.md', X, page()), [
    'R.md: its guide, site/guide/x.md, is missing; fix LINKS in scripts/check-readmes.mjs',
    'R.md: its SPEC, docs/framework/SPEC-x.md, is missing; fix LINKS in scripts/check-readmes.mjs',
  ]);
});

test('a package with no guide and SPEC on record fails until it gets them', () => {
  assert.deepEqual(
    pageProblems(PAGES, 'R.md', { name: '@yea-protocol/x' }, page()),
    [
      'R.md: no guide and SPEC on record for @yea-protocol/x; add them to LINKS in scripts/check-readmes.mjs',
    ],
  );
});

test('an install in a comment, a quoted banner block or a text block is not the install line', () => {
  const pages = [
    installing('# npm i @yea-protocol/x  (soon)'),
    `${installing('true')}\n> \`\`\`sh\n> npm i @yea-protocol/x\n> \`\`\`\n`,
    page().replace('```sh', '```text'),
  ];

  for (const md of pages) {
    assert.deepEqual(
      pageProblems(PAGES, 'R.md', X, md),
      ['R.md: no shell block that installs @yea-protocol/x'],
      md,
    );
  }
});

test('an install with a comment after it, a # inside a word, or under a list item counts', () => {
  const pages = [
    installing('npm i @yea-protocol/x # the bridge'),
    installing('npm i some/repo#semver:1 @yea-protocol/x'),
    page()
      .replace('```sh\n', '- a\n\n  ```sh\n  ')
      .replace('4\n```', '4\n  ```'),
  ];

  for (const md of pages) {
    assert.deepEqual(pageProblems(PAGES, 'R.md', X, md), [], md);
  }
});

test('a package page has no relative link in a link, a definition or an HTML attribute', () => {
  const extra = [
    '[mcp](../../mcp) [risk](#risk) <img src="./logo.svg">',
    '<a href="../cli">cli</a> [spec][s] and a note[^1]',
    '[t](../titled.md "a title") <a href=\'../single\'>s</a> <a href=../bare>b</a>',
    '',
    '[s]: docs/SPEC.md',
    '[^1]: a footnote, not a link',
    '[g]: https://yea-protocol.github.io/yea/guide/x',
    '  [i]: ../indented.md',
    '[a]: <../angle.md>',
    '[n]:',
    '  ../next-line.md',
    '> [q]: ../quoted.md',
    '',
    '[Note]: this is prose, not a definition',
    'Text, then a line that only looks like one:',
    '    [c]: ../continued.md',
  ].join('\n');
  const relative = [
    '../../mcp',
    '../titled.md',
    'docs/SPEC.md',
    '../indented.md',
    '../angle.md',
    '../next-line.md',
    '../quoted.md',
    './logo.svg',
    '../cli',
    '../single',
    '../bare',
  ];

  assert.deepEqual(
    pageProblems(PAGES, 'R.md', X, page(extra)),
    relative.map(
      (link) => `R.md: a relative link npm and PyPI can't follow: ${link}`,
    ),
  );
});

test('code on a package page is not a link: not a relative one, and not its guide', () => {
  const code = [
    '```ts',
    '  [key: string]: unknown;',
    '  [refund.name]: refund,',
    'await handlers[name](args);',
    '<a href="/pricing">pricing</a>',
    '```',
    '',
    '    <img src="./logo.svg">',
  ].join('\n');
  const guide = '[Guide](https://yea-protocol.github.io/yea/guide/x) ·';
  const noGuide = [
    'R.md: no absolute link to its guide (https://yea-protocol.github.io/yea/guide/x)',
  ];

  assert.deepEqual(pageProblems(PAGES, 'R.md', X, page(`\n${code}`)), []);
  assert.deepEqual(
    pageProblems(
      PAGES,
      'R.md',
      X,
      page().replace(guide, `\`\`\`text\n${guide}\n\`\`\``),
    ),
    noGuide,
  );
  assert.deepEqual(
    pageProblems(
      PAGES,
      'R.md',
      X,
      page().replace(guide, '`https://yea-protocol.github.io/yea/guide/x`'),
    ),
    noGuide,
  );
});

test('a reference-style link to its guide counts', () => {
  const md = page().replace(
    '[Guide](https://yea-protocol.github.io/yea/guide/x) ·',
    '[Guide][g]\n\n[g]: https://yea-protocol.github.io/yea/guide/x',
  );

  assert.deepEqual(pageProblems(PAGES, 'R.md', X, md), []);
});

test('a line with backticks after the fence is inline code, not a fence', () => {
  const root = repoWith({ 'ex.py': PY });
  const md = `${pinned('def hello():\n    print("hi")')}\n\`\`\`ts\`\`\` is how to name it.\n`;

  assert.deepEqual(snippetProblems(root, 'R.md', md), []);
});
