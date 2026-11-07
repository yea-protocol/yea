/**
 * A package README as its npm or PyPI page (#323): it installs its package in a shell block,
 * links its guide and its SPEC with absolute URLs, and has no relative link, which npm and PyPI
 * can't follow.
 */
import { relativeLinks } from '../sync-readme.mjs';

const GUIDE = '](https://yea-protocol.github.io/yea/guide/';
const SPEC =
  /\]\(https:\/\/github\.com\/yea-protocol\/yea\/blob\/main\/[\w/-]*SPEC[\w-]*\.md\b/;
const SHELL_BLOCK = /^```(?:sh|bash|shell|console)\b.*\n([\s\S]*?)^```/gm;
/** An install, or for a bin (an MCP server's config, say) `npx`, which installs and runs it. */
const INSTALL =
  /\b(npm (i|install|add)|npx|uv add|uv pip install|pip install)\b/;

/** The lines of each shell block in `md`. */
function shellLines(md) {
  return [...md.matchAll(SHELL_BLOCK)].flatMap((m) => m[1].split('\n'));
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

/**
 * A line for each way the README `readme`, whose text is `md`, fails as the page of the package
 * `name`.
 */
export function pageProblems(readme, name, md) {
  const problems = [];

  if (!shellLines(md).some((line) => installs(line, name))) {
    problems.push(`no shell block that installs ${name}`);
  }

  if (!md.includes(GUIDE)) {
    problems.push(
      'no absolute link to its guide (https://yea-protocol.github.io/yea/guide/…)',
    );
  }

  if (!SPEC.test(md)) {
    problems.push(
      'no absolute link to its SPEC (https://github.com/yea-protocol/yea/blob/main/…SPEC….md)',
    );
  }

  for (const link of relativeLinks(md)) {
    problems.push(`a relative link npm and PyPI can't follow: ${link}`);
  }

  return problems.map((p) => `${readme}: ${p}`);
}
