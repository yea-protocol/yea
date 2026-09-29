/**
 * The appearance switch gets a static accessible name (site/.vitepress/switch-label.ts), and a
 * VitePress update that changes its markup fails the build instead of dropping the name. Imports a
 * TypeScript source, so it needs Node's type stripping (22.18+) and skips without it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const skip = process.features.typescript
  ? false
  : 'needs Node with type stripping (22.18+) to import .ts';
const load = () => import('../.vitepress/switch-label.ts');

// As VitePress 1.6 server-renders it (from the built guide pages).
const RENDERED =
  '<button class="VPSwitch VPSwitchAppearance" type="button" role="switch" title aria-checked="false" data-v-6c893767>';

test('the server-rendered switch gets aria-label "Dark theme"', {
  skip,
}, async () => {
  const { labelAppearanceSwitch } = await load();

  assert.match(
    labelAppearanceSwitch(RENDERED),
    /role="switch" aria-label="Dark theme" title aria-checked/,
  );
});

test('a page without the switch is left alone', { skip }, async () => {
  const { labelAppearanceSwitch } = await load();

  assert.equal(labelAppearanceSwitch('<p>no switch</p>'), '<p>no switch</p>');
});

test('changed switch markup fails loudly instead of silently dropping the name', {
  skip,
}, async () => {
  const { labelAppearanceSwitch } = await load();
  const reordered =
    '<button type="button" class="VPSwitch VPSwitchAppearance" role="switch" title>';

  assert.throws(
    () => labelAppearanceSwitch(reordered, 'guide/x.md'),
    /guide\/x\.md has the appearance switch/,
  );
});
