/**
 * Tests for the docs' markdown rules and Lens colouring, rendered through VitePress's own
 * markdown renderer: task-list checkboxes carry their item's text as a label, heading levels
 * never skip (a skipped run moves as a whole), and Lens lines in plain-text fences get their
 * protocol-state class. They import TypeScript sources, so they need Node's type stripping
 * (22.18+) and skip without it. One more rule reads the source text, not the render: an
 * approval claim on a page adopters read links to what an approval proves (#337).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** A claim that the model or the client can't approve, or that the person is asked. */
const CLAIM = /can['’]t approve|asks the person/i;
/** A link to the threat model, in SPEC-approval §9 or the security guide's summary of it. */
const PROOF = /(guide\/security|SPEC-approval\.md)#what-an-approval-proves/;

const skip = process.features.typescript
  ? false
  : 'needs Node with type stripping (22.18+) to import .ts';

let renderer;

async function render(src) {
  renderer ??= await makeRenderer();

  return renderer.render(src);
}

async function makeRenderer() {
  const { createMarkdownRenderer } = await import('vitepress');
  const { headingOrder, taskLists } = await import(
    '../.vitepress/markdown-rules.ts'
  );
  const { lensFence } = await import('../.vitepress/lens-fence.ts');

  return createMarkdownRenderer('.', {
    codeTransformers: [lensFence],
    config(m) {
      taskLists(m);
      headingOrder(m);
    },
  });
}

/** The lens-<state> class of each line in the first code block ('' when unclassed). */
async function lensClasses(fence) {
  const html = await render(fence);
  const code = html.slice(html.indexOf('<code'), html.indexOf('</code>'));

  return [...code.matchAll(/class="line( lens-[a-z]+)?"/g)].map(
    (m) => m[1]?.trim() ?? '',
  );
}

test('a task-list checkbox is labelled by its item', { skip }, async () => {
  const html = await render(
    '- [ ] Names and `emails` work\n- [x] Done\n- [ ] A \\* star\n',
  );

  assert.match(
    html,
    /<input type="checkbox" class="task-list-item-checkbox" aria-label="Names and emails work">/,
  );
  assert.match(html, /aria-label="Done" checked>/);
  assert.match(html, /aria-label="A \* star">/);
});

test('headings that skip a level are lifted as a run', { skip }, async () => {
  const tags = async (src) =>
    [...(await render(src)).matchAll(/<(h\d)[^>]*>/g)].map((m) => m[1]);

  assert.deepEqual(await tags('# P\n\n### A\n\n#### A1\n\n### B\n\n## C\n'), [
    'h1',
    'h2',
    'h3',
    'h2',
    'h2',
  ]);
  assert.deepEqual(await tags('# P\n\n## A\n\n### B\n\n## C\n'), [
    'h1',
    'h2',
    'h3',
    'h2',
  ]);
});

test('Lens lines in a text fence get their state class', { skip }, async () => {
  const classes = await lensClasses(
    [
      '```text',
      '→ COMMIT p_1',
      '✗ consent_required: over the limit',
      '✗ unknown_capability: calendar.move',
      '[p_1] 4 meals',
      '  + create order/o1',
      '✓ placed (receipt r_1)',
      '… 40 more at items — EXPAND h_1',
      'a plain line',
      '```',
    ].join('\n'),
  );

  assert.deepEqual(classes, [
    'lens-wire',
    'lens-amber',
    'lens-red',
    'lens-amber',
    'lens-effect',
    'lens-green',
    'lens-more',
    '',
  ]);
});

test('a fence with no language is read as Lens', { skip }, async () => {
  assert.deepEqual(await lensClasses('```\n✓ done\nplain\n```'), [
    'lens-green',
    '',
  ]);
});

test('other languages, plaintext and no-lens fences stay plain', {
  skip,
}, async () => {
  for (const info of ['ts', 'plaintext', 'text no-lens']) {
    assert.deepEqual(
      await lensClasses(`\`\`\`${info}\n✓ done\n  - id: 1\n\`\`\``),
      ['', ''],
      info,
    );
  }
});

/** The paragraphs of `text` that make an approval claim without linking to what it proves. */
function bareClaims(text) {
  return text.split(/\n\s*\n/).filter((p) => CLAIM.test(p) && !PROOF.test(p));
}

/** The pages adopters read: both READMEs, the site's pages and its landing components. */
function adopterPages() {
  const site = join(ROOT, 'site');
  const pages = readdirSync(site, { recursive: true, encoding: 'utf8' })
    .filter((f) => !/(^|\/)(node_modules|dist|cache)\//.test(f))
    .filter((f) => f.endsWith('.md') || /^\.vitepress\/theme\/.*\.vue$/.test(f))
    .map((f) => join(site, f));

  return [
    join(ROOT, 'README.md'),
    join(ROOT, 'python', 'mcp', 'README.md'),
    ...pages,
  ];
}

test('an approval claim without a link to what it proves is caught', () => {
  const link = '[what it proves](/guide/security#what-an-approval-proves)';

  assert.deepEqual(bareClaims("The model can't approve it.\n\nNext."), [
    "The model can't approve it.",
  ]);
  assert.deepEqual(bareClaims('It asks the person\nfirst.'), [
    'It asks the person\nfirst.',
  ]);
  assert.deepEqual(bareClaims(`The model can’t approve it\n(${link}).`), []);
  assert.deepEqual(bareClaims('Nothing the model sends approves it.'), []);
});

test('every approval claim adopters read links to what it proves', () => {
  const pages = adopterPages();
  const bare = pages.flatMap((f) =>
    bareClaims(readFileSync(f, 'utf8')).map(
      (p) => `${relative(ROOT, f)}: ${p.match(CLAIM)?.[0]}`,
    ),
  );

  assert.ok(pages.some((f) => f.endsWith('PathsSection.vue')));
  assert.ok(pages.some((f) => f.endsWith(join('guide', 'security.md'))));
  assert.deepEqual(bare, []);
});
