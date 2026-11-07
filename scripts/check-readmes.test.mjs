/**
 * Tests for check-readmes.mjs: the repo's READMEs pass, every published package but the SDK has
 * a page, a snippet must match its region (`// #region` or Python's `# region`), every code
 * block must be pinned, and a package page must install its package, link its guide and SPEC
 * absolutely, and have no relative link.
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

/** A package page that passes, with `extra` appended. */
const page = (extra = '') =>
  [
    '```sh',
    'npm i @yea-protocol/x zod@4',
    '```',
    '[Guide](https://yea-protocol.github.io/yea/guide/x) ·',
    '[spec](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-x.md)',
    extra,
  ].join('\n');

test("the repo's READMEs pass", () => {
  assert.deepEqual(readmeProblems(ROOT), []);
});

test('every published package but the SDK has a page, named for what it installs', () => {
  assert.deepEqual(packageReadmes(ROOT), [
    { readme: 'cli/README.md', name: '@yea-protocol/cli' },
    { readme: 'mcp/README.md', name: '@yea-protocol/mcp' },
    { readme: 'connectors/stripe/README.md', name: '@yea-protocol/stripe' },
    { readme: 'python/README.md', name: 'yea-sdk' },
    { readme: 'python/mcp/README.md', name: 'yea-mcp' },
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
  assert.throws(() => region(root, 'ex.ts', 'b'), /ex\.ts has no region b/);
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

test('a package page installs its package and links its guide and SPEC absolutely', () => {
  assert.deepEqual(pageProblems('R.md', '@yea-protocol/x', page()), []);
  assert.deepEqual(pageProblems('R.md', '@yea-protocol/x-tra', page()), [
    'R.md: no shell block that installs @yea-protocol/x-tra',
  ]);
  assert.deepEqual(
    pageProblems('R.md', 'yea-mcp', "```sh\nuv add 'yea-mcp[fastmcp]'\n```"),
    [
      'R.md: no absolute link to its guide (https://yea-protocol.github.io/yea/guide/…)',
      'R.md: no absolute link to its SPEC (https://github.com/yea-protocol/yea/blob/main/…SPEC….md)',
    ],
  );
});

test('a package page has no relative link: npm and PyPI cannot follow one', () => {
  const extra = '[mcp](../../mcp) [risk](#risk) <img src="./logo.svg">';

  assert.deepEqual(pageProblems('R.md', '@yea-protocol/x', page(extra)), [
    "R.md: a relative link npm and PyPI can't follow: ../../mcp",
    "R.md: a relative link npm and PyPI can't follow: ./logo.svg",
  ]);
});
