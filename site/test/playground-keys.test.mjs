/**
 * Tests for the playground's pure keyboard helpers: roving.ts's arrow-key movement (both
 * orientations, wrapping, Home and End) and shortcut.ts's send shortcut and its names.
 * They import the TypeScript sources directly, so they need Node's type stripping (22.18+);
 * on an older Node they are skipped.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const THEME = '../.vitepress/theme/components/playground';
const skip = process.features.typescript
  ? false
  : 'needs Node with type stripping (22.18+) to import .ts';
const load = async () => ({
  ...(await import(`${THEME}/roving.ts`)),
  ...(await import(`${THEME}/shortcut.ts`)),
});

test('moveIndex: a radiogroup takes all four arrows and wraps', {
  skip,
}, async () => {
  const { moveIndex } = await load();

  assert.equal(moveIndex('ArrowRight', 0, 3, 'both'), 1);
  assert.equal(moveIndex('ArrowDown', 1, 3, 'both'), 2);
  assert.equal(moveIndex('ArrowRight', 2, 3, 'both'), 0);
  assert.equal(moveIndex('ArrowLeft', 0, 3, 'both'), 2);
  assert.equal(moveIndex('ArrowUp', 2, 3, 'both'), 1);
});

test('moveIndex: a horizontal tablist takes Left and Right only', {
  skip,
}, async () => {
  const { moveIndex } = await load();

  assert.equal(moveIndex('ArrowRight', 1, 2, 'horizontal'), 0);
  assert.equal(moveIndex('ArrowLeft', 0, 2, 'horizontal'), 1);
  assert.equal(moveIndex('ArrowDown', 0, 2, 'horizontal'), null);
  assert.equal(moveIndex('ArrowUp', 1, 2, 'horizontal'), null);
});

test('moveIndex: Home and End in either orientation; other keys do nothing', {
  skip,
}, async () => {
  const { moveIndex } = await load();

  for (const o of ['both', 'horizontal']) {
    assert.equal(moveIndex('Home', 4, 6, o), 0);
    assert.equal(moveIndex('End', 1, 6, o), 5);
    assert.equal(moveIndex('Enter', 1, 6, o), null);
    assert.equal(moveIndex('a', 1, 6, o), null);
  }
});

test('isSendShortcut: ⌘↵ or Ctrl+↵, and nothing else', { skip }, async () => {
  const { isSendShortcut } = await load();
  const key = (o) => ({ key: 'Enter', metaKey: false, ctrlKey: false, ...o });

  assert.equal(isSendShortcut(key({ metaKey: true })), true);
  assert.equal(isSendShortcut(key({ ctrlKey: true })), true);
  assert.equal(isSendShortcut(key({})), false);
  assert.equal(isSendShortcut(key({ key: 'a', metaKey: true })), false);
});

test('sendKeys and the hints: both shortcuts, this platform first', {
  skip,
}, async () => {
  const { copyKeys, sendHint, sendKeys } = await load();

  assert.equal(sendKeys(true), 'Meta+Enter Control+Enter');
  assert.equal(sendKeys(false), 'Control+Enter Meta+Enter');
  assert.equal(sendHint(true), '⌘↵');
  assert.equal(sendHint(false), 'Ctrl+↵');
  assert.equal(copyKeys(false), 'Ctrl+C');
});
