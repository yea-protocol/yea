/**
 * Head tags that depend on the theme or the first paint: a one-time reset of the appearance the
 * old dark-only site stored, a mark that JavaScript runs, the theme-color meta (the theme keeps
 * it in step with the toggle), and preloads for the fonts the first paint needs.
 */
import type { HeadConfig } from 'vitepress';

/** The browser chrome colour for each theme: paper in light, ink in dark. */
export const THEME_COLORS = { light: '#F7F5F0', dark: '#0B0D12' } as const;

/**
 * The site was dark-only (`appearance: 'dark'`), so VitePress stored 'dark' for every visitor.
 * Clear that once, so returning readers follow their OS like new ones; a choice made after this
 * runs is kept. It must come before VitePress's own check-dark-mode script, which reads the key.
 */
export const appearanceMigration: HeadConfig = [
  'script',
  { id: 'yea-theme-v2' },
  `;(() => { try {
    if (localStorage.getItem('yea-theme-v2')) return
    if (localStorage.getItem('vitepress-theme-appearance') === 'dark')
      localStorage.removeItem('vitepress-theme-appearance')
    localStorage.setItem('yea-theme-v2', '1')
  } catch {} })()`,
];

/**
 * Marks the page as running JavaScript before first paint, so the landing's thread can start
 * empty and play instead of flashing its finished recording first. Without JavaScript (or if
 * the app never starts; the landing's CSS times the mark out) the finished recording shows.
 */
export const jsMarker: HeadConfig = [
  'script',
  { id: 'yea-js' },
  "document.documentElement.classList.add('yea-js')",
];

/** One theme-color meta, light until the theme syncs it with the current appearance. */
export const themeColor: HeadConfig = [
  'meta',
  { name: 'theme-color', content: THEME_COLORS.light },
];

const BODY_FONT = /public-sans-latin-wght-normal\.[\w-]+\.woff2$/;
const MONO_FONT = /jetbrains-mono-latin-wght-normal\.[\w-]+\.woff2$/;

/** A preload link for Public Sans (Latin, roman), found among the built assets. */
export function preloadBodyFont(assets: string[]): HeadConfig[] {
  const font = assets.find((a) => BODY_FONT.test(a));

  if (!font) {
    console.warn(
      'head: no Public Sans latin woff2 among the assets to preload',
    );

    return [];
  }

  return [preload(font)];
}

/**
 * The fonts a page needs for its first paint: Public Sans everywhere, and JetBrains Mono on the
 * home page, whose hero shows mono Lens above the fold.
 */
export function fontPreloads(
  assets: string[],
  relativePath: string,
): HeadConfig[] {
  const mono =
    relativePath === 'index.md' ? assets.find((a) => MONO_FONT.test(a)) : null;

  return [...preloadBodyFont(assets), ...(mono ? [preload(mono)] : [])];
}

function preload(href: string): HeadConfig {
  return [
    'link',
    { rel: 'preload', href, as: 'font', type: 'font/woff2', crossorigin: '' },
  ];
}
