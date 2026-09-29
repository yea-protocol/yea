/**
 * Tests for the docs' markdown rules and Lens colouring, rendered through VitePress's own
 * markdown renderer: task-list checkboxes carry their item's text as a label, heading levels
 * never skip (a skipped run moves as a whole), and Lens lines in plain-text fences get their
 * protocol-state class. They import TypeScript sources, so they need Node's type stripping
 * (22.18+) and skip without it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

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
