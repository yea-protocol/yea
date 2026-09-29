/**
 * Tests for the docs' markdown rules and Lens colouring, rendered through VitePress's own
 * markdown renderer: task-list checkboxes carry their item's text as a label, heading levels
 * never skip, and Lens lines in plain-text fences get their protocol-state class. They import
 * TypeScript sources, so they need Node's type stripping (22.18+) and skip without it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const skip = process.features.typescript
  ? false
  : 'needs Node with type stripping (22.18+) to import .ts';

async function render(src) {
  const { createMarkdownRenderer } = await import('vitepress');
  const { headingOrder, taskLists } = await import(
    '../.vitepress/markdown-rules.ts'
  );
  const { lensLines } = await import('../.vitepress/lens-fence.ts');
  const md = await createMarkdownRenderer('.', {
    codeTransformers: [lensLines],
    config(m) {
      taskLists(m);
      headingOrder(m);
    },
  });

  return md.render(src);
}

test('a task-list checkbox is labelled by its item', { skip }, async () => {
  const html = await render('- [ ] Names and `emails` work\n- [x] Done\n');

  assert.match(
    html,
    /<input type="checkbox" class="task-list-item-checkbox" aria-label="Names and emails work">/,
  );
  assert.match(html, /aria-label="Done" checked>/);
});

test('a heading that skips a level is lifted; others stay', {
  skip,
}, async () => {
  const html = await render(
    '# Page\n\ntext\n\n### Skipped\n\n## Section\n\n### Sub\n',
  );
  const tags = [...html.matchAll(/<(h\d)[^>]*>/g)].map((m) => m[1]);

  assert.deepEqual(tags, ['h1', 'h2', 'h2', 'h3']);
});

test('Lens lines in a text fence get their state class', { skip }, async () => {
  const html = await render(
    [
      '```text',
      '→ COMMIT p_1',
      '✗ consent_required: over the limit',
      '[p_1] 4 meals',
      '  + create order/o1',
      '✓ placed (receipt r_1)',
      '```',
      '',
      '```ts',
      '✓ not lens',
      '```',
    ].join('\n'),
  );
  const classes = [...html.matchAll(/class="line( lens-[a-z]+)?"/g)].map(
    (m) => m[1]?.trim() ?? '',
  );

  assert.deepEqual(classes, [
    'lens-wire',
    'lens-amber',
    'lens-amber',
    'lens-effect',
    'lens-green',
    '',
  ]);
});
