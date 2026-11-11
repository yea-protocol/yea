/**
 * The packed READMEs, which become the npm and PyPI pages (#323). Every npm tarball needs one:
 * npm packs a README whatever `files` says, so a tarball without one has none to pack. And a
 * release's READMEs can't say the package is unreleased: a published version's page can't be
 * changed, so the banners come out before the tag.
 */
import { sh } from './shell.mjs';

/**
 * A line saying the package isn't out, however it's worded ("Unreleased", "Pre-release", "not
 * yet released", "isn't on npm"): the claim that goes stale once the version is published.
 */
const BANNER =
  /\bunreleased\b|\bnot yet released\b|\bpre-?release\b|(n['’]t|\bnot) on (npm|pypi)\b/i;

/** A line for each npm pack (`{ name, paths }`, as `npm pack --json` lists it) without a README. */
export function missingReadmes(packs) {
  return packs
    .filter(({ paths }) => !paths.includes('README.md'))
    .map(({ name }) => `${name}: the tarball has no README.md`);
}

/**
 * A line when the README at `path` in the archive `archive` (a .tgz or .tar.gz) still says the
 * package is unreleased, naming the package `name` and the lines that say it.
 */
export function unreleasedReadme(name, archive, path) {
  const text = sh('tar', ['-xOzf', archive, path]);
  const lines = text
    .split('\n')
    .flatMap((line, i) => (BANNER.test(line) ? [i + 1] : []));

  return lines.length === 0
    ? []
    : [
        `${name}: its README still says it isn't released (line ${lines.join(', ')}); take the banners out before the tag`,
      ];
}
