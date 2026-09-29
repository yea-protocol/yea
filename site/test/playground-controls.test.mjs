/**
 * Two playground styles a later edit could quietly undo (#228): the Send button can't shrink below
 * 44px in its fixed-height pane, and the field rule doesn't reset the select's chevron with the
 * `background` shorthand. Read from the source, since the site has no browser tests.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) =>
  readFileSync(
    new URL(`../.vitepress/theme/components/playground/${p}`, import.meta.url),
    'utf8',
  );

test('the Send button keeps its 44px height in the fixed-height pane', () => {
  const rule = read('RequestPane.vue').match(/\n\.send \{[^}]*\}/)?.[0] ?? '';

  assert.match(rule, /height: 44px/);
  assert.match(rule, /flex-shrink: 0/);
});

test('no rule after the select chevron resets it with the background shorthand', () => {
  const css = read('controls.css');
  const after = css.slice(css.indexOf('background-image: linear-gradient'));

  assert.doesNotMatch(after, /(^|[\s;{])background:/);
});
