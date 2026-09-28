/** Copy docs/brand into site/public/brand so the site always ships the repo's brand files. */
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const src = new URL('../../docs/brand/', import.meta.url),
  dst = new URL('../public/brand/', import.meta.url);

if (!existsSync(src)) {
  process.exit(0);
}

mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
