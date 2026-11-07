/**
 * The pages adopters read, and the units the source-text rules check one at a time, shared by
 * markdown-rules.test.mjs (approval claims) and instructions.test.mjs (install and run lines).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The units a rule checks on their own: paragraphs, then each table row, each list item and each
 * block element (`<p>`, `<li>`, …), so one link can't excuse a whole table, list or template.
 */
export function units(text) {
  return text
    .split(/\n\s*\n/)
    .flatMap((p) =>
      p.split(
        /\n(?=\s*\|)|\n(?=\s*(?:[-*+]|\d+\.)\s)|(?=<(?:p|li|h[1-6]|td|th|dd|blockquote)\b)/,
      ),
    );
}

/** Every `README.md` one level under `dir`, such as each connector's npm page. */
const readmesUnder = (dir) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(ROOT, dir, d.name, 'README.md'))
    .filter((f) => existsSync(f));

/** The pages adopters read: the READMEs, the site's pages and its landing components. */
export function adopterPages() {
  const site = join(ROOT, 'site');
  const pages = readdirSync(site, { recursive: true, encoding: 'utf8' })
    .filter((f) => !/(^|\/)(node_modules|dist|cache)\//.test(f))
    .filter((f) => f.endsWith('.md') || /^\.vitepress\/theme\/.*\.vue$/.test(f))
    .map((f) => join(site, f));

  return [
    join(ROOT, 'README.md'),
    join(ROOT, 'cli', 'README.md'),
    join(ROOT, 'python', 'mcp', 'README.md'),
    ...readmesUnder('connectors'),
    ...pages,
  ];
}
