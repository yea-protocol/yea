/**
 * Copy docs/brand into site/public/brand so the site always ships the repo's brand files. The
 * social card's HTML source stays out: it's the template for social.png, not a page.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const src = new URL('../../docs/brand/', import.meta.url),
  dst = new URL('../public/brand/', import.meta.url);

if (!existsSync(src)) {
  process.exit(0);
}

mkdirSync(dst, { recursive: true });
rmSync(new URL('social.html', dst), { force: true });
cpSync(src, dst, {
  recursive: true,
  filter: (from) => !from.endsWith('.html'),
});
