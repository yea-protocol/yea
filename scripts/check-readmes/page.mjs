/**
 * A package README as its npm or PyPI page (#323): it installs its package in a shell block,
 * links its own guide and its own SPEC with absolute URLs, and has no relative link, which npm
 * and PyPI can't follow.
 */
import { links, relativeLinks } from '../sync-readme.mjs';
import { fences } from './fences.mjs';

const GUIDES = 'https://yea-protocol.github.io/yea/guide/';
const REPO = 'https://github.com/yea-protocol/yea/blob/main/';
const SHELL = new Set(['sh', 'bash', 'shell', 'console']);
/** An install, or for a bin (an MCP server's config, say) `npx`, which installs and runs it. */
const INSTALL =
  /\b(npm (i|install|add)|npx|uv add|uv pip install|pip install)\b/;

/**
 * The lines of each shell block in `md`, without comments. Blocks in a blockquote are left out:
 * there, an install is a banner's stopgap, not the page's install line.
 */
function shellLines(md) {
  return fences(md)
    .filter(({ lang, quoted }) => SHELL.has(lang) && !quoted)
    .flatMap(({ code }) => code.split('\n'))
    .map((line) => line.replace(/(^|\s)#.*$/, ''));
}

/** True when `word` names the package `name`, maybe with a version or extras: `name@1`, `name[x]`. */
function names(word, name) {
  const unquoted = word.replace(/^['"]|['"]$/g, '');

  return (
    unquoted.startsWith(name) && /^([@[]|$)/.test(unquoted.slice(name.length))
  );
}

/** True when the shell `line` installs the package `name`. */
function installs(line, name) {
  return INSTALL.test(line) && line.split(/\s+/).some((w) => names(w, name));
}

/** True when `md` links to `url`, or to an anchor in it. */
function linksTo(md, url) {
  return links(md).some((u) => u === url || u.startsWith(`${url}#`));
}

/** A line for each of the links `md` must have and doesn't: to the package's `guide` and `spec`. */
function missingLinks(md, { guide, spec }) {
  const wanted = [
    ['guide', `${GUIDES}${guide}`],
    ['SPEC', `${REPO}${spec}`],
  ];

  return wanted
    .filter(([, url]) => !linksTo(md, url))
    .map(([what, url]) => `no absolute link to its ${what} (${url})`);
}

/**
 * A line for each way the README `readme`, whose text is `md`, fails as the page of the package
 * `page`: its name, its guide's slug on the site, and its SPEC's path in the repo.
 */
export function pageProblems(readme, page, md) {
  const { name, guide, spec } = page;

  if (guide === undefined || spec === undefined) {
    return [
      `${readme}: no guide and SPEC on record for ${name}; add them to LINKS in scripts/check-readmes.mjs`,
    ];
  }

  const install = shellLines(md).some((line) => installs(line, name))
    ? []
    : [`no shell block that installs ${name}`];
  const relative = relativeLinks(md).map(
    (link) => `a relative link npm and PyPI can't follow: ${link}`,
  );

  return [...install, ...missingLinks(md, page), ...relative].map(
    (p) => `${readme}: ${p}`,
  );
}
