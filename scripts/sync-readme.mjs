/**
 * Copies the root README into ts/ (npm) with relative links made absolute, so
 * the npm page renders images and links correctly. ts/'s `prepack` runs it,
 * so every tarball carries the synced copy; `--check` fails instead when the
 * tracked ts/README.md has drifted from the root README.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = 'https://raw.githubusercontent.com/yea-protocol/yea/main/';
const BLOB = 'https://github.com/yea-protocol/yea/blob/main/';
const isRel = (u) => !/^(https?:|#|mailto:)/.test(u);
const isImg = (u) => /\.(svg|png|jpe?g|gif)$/i.test(u);
const abs = (u) =>
  isRel(u) ? (isImg(u) ? RAW : BLOB) + u.replace(/^\.\//, '') : u;
const LINK = /\]\(([^)\s]+)\)/g;
/** A reference definition, `[label]: url` (`[^1]: …` is a footnote, not one). */
const REF = /^( {0,3}\[(?!\^)[^\]]+\]:[ \t]*<?)([^\s>]+)/gm;
/** An HTML attribute that holds a URL: an image's source, an anchor's target. */
const ATTR = /(src|srcset|href)="([^"]+)"/g;

/** The SDK's npm README: the root README under `root`, with absolute links. */
export function syncedReadme(root) {
  return readFileSync(join(root, 'README.md'), 'utf8')
    .replace(LINK, (_, u) => `](${abs(u)})`)
    .replace(REF, (_, head, u) => `${head}${abs(u)}`)
    .replace(ATTR, (_, a, u) => `${a}="${abs(u)}"`);
}

/** Every link and image source in `md`, in each syntax `syncedReadme` rewrites. */
export function links(md) {
  return [
    ...[...md.matchAll(LINK)].map((m) => m[1]),
    ...[...md.matchAll(REF)].map((m) => m[2]),
    ...[...md.matchAll(ATTR)].map((m) => m[2]),
  ];
}

/** The links and image sources in `md` that npm and PyPI can't follow: the ones `abs` rewrites. */
export function relativeLinks(md) {
  return links(md).filter((u) => abs(u) !== u);
}

/** True when ts/README.md under `root` is the synced root README. */
export function readmeInSync(root) {
  return (
    readFileSync(join(root, 'ts', 'README.md'), 'utf8') === syncedReadme(root)
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));

  if (process.argv[2] === '--check') {
    if (!readmeInSync(root)) {
      console.error(
        'ts/README.md is out of sync: run node scripts/sync-readme.mjs',
      );
      process.exitCode = 1;
    }
  } else {
    writeFileSync(join(root, 'ts', 'README.md'), syncedReadme(root));
    console.error('ts/README.md synced'); // stderr: npm pack --json owns stdout
  }
}
