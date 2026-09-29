/**
 * Tests for the theme's config-side pieces: every token colour in the paper-tuned Shiki theme
 * reads at 4.5:1 or better on the light code background, and the font preloads pick the hashed
 * files VitePress builds. They import TypeScript sources, so they need Node's type stripping
 * (22.18+) and skip without it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const skip = process.features.typescript
  ? false
  : 'needs Node with type stripping (22.18+) to import .ts';
const shiki = () => import('../.vitepress/shiki-light.ts');
const head = () => import('../.vitepress/head.ts');

const CODE_BG = '#ECE8DF';

test('every paperLight token colour clears 4.5:1 on the code background', {
  skip,
}, async () => {
  const { paperLight } = await shiki();
  const colours = new Set(
    (paperLight.tokenColors ?? [])
      .map((t) => t.settings.foreground)
      .filter((c) => typeof c === 'string'),
  );

  assert.ok(colours.size > 5, 'the theme has token colours');

  for (const c of colours) {
    // #fafbfc-style backgrounds of diff markers are backgrounds, not text.
    if (luminance(c) > 0.8) {
      continue;
    }

    const ratio = contrast(c, CODE_BG);

    assert.ok(ratio >= 4.5, `${c} is ${ratio.toFixed(2)}:1 on ${CODE_BG}`);
  }
});

test('preloadBodyFont picks the hashed Public Sans latin file', {
  skip,
}, async () => {
  const { preloadBodyFont } = await head();
  const assets = [
    '/yea/assets/public-sans-latin-ext-wght-normal.MQgHevqp.woff2',
    '/yea/assets/public-sans-latin-wght-italic.DGZ7iaiu.woff2',
    '/yea/assets/public-sans-latin-wght-normal.DdeTHZLK.woff2',
    '/yea/assets/jetbrains-mono-latin-wght-normal.B9CIFXIH.woff2',
  ];
  const [link] = preloadBodyFont(assets);

  assert.equal(link[0], 'link');
  assert.equal(
    link[1].href,
    '/yea/assets/public-sans-latin-wght-normal.DdeTHZLK.woff2',
  );
  assert.equal(link[1].as, 'font');
});

test('the home page also preloads the mono font; other pages do not', {
  skip,
}, async () => {
  const { fontPreloads } = await head();
  const assets = [
    '/yea/assets/public-sans-latin-wght-normal.DdeTHZLK.woff2',
    '/yea/assets/jetbrains-mono-latin-wght-normal.B9CIFXIH.woff2',
  ];
  const hrefs = (path) => fontPreloads(assets, path).map((l) => l[1].href);

  assert.deepEqual(hrefs('index.md'), assets);
  assert.deepEqual(hrefs('guide/intents.md'), [assets[0]]);
});

function luminance(hex) {
  const channels = [1, 3, 5].map(
    (i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const [r, g, b] = channels.map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);

  return (hi + 0.05) / (lo + 0.05);
}
