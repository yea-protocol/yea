/**
 * Copies the root README into ts/ (npm) with relative links made absolute, so
 * the npm page renders images and links correctly; code blocks are copied as
 * they are. ts/'s `prepack` runs it, so every tarball carries the synced copy;
 * `--check` fails instead when the tracked ts/README.md has drifted from the
 * root README.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runs } from './code-blocks.mjs';

const RAW = 'https://raw.githubusercontent.com/yea-protocol/yea/main/';
const BLOB = 'https://github.com/yea-protocol/yea/blob/main/';
const isRel = (u) => !/^(https?:|#|mailto:)/.test(u);
const isImg = (u) => /\.(svg|png|jpe?g|gif)$/i.test(u);
const abs = (u) =>
  isRel(u) ? (isImg(u) ? RAW : BLOB) + u.replace(/^\.\//, '') : u;
/** An inline link's URL, maybe followed by a title: `](url)`, `](url "title")`. */
const LINK = /(\]\()([^)\s]+)(?=\)|\s+["'(])/g;
/**
 * A reference definition's URL, `[label]: url`: in a blockquote too, maybe in `<>` or on the
 * next line, and followed by nothing but a title (`[^1]: …` is a footnote, not one).
 */
const REF =
  /^((?: {0,3}> ?)* {0,3}\[(?!\^)[^\]]+\]:[ \t]*(?:\r?\n[ \t>]*)?<?)([^\s>]+)(?=>?[ \t]*(?:$|["'(]))/gm;
/** A URL in an HTML attribute, in either quotes or none: an image's source, an anchor's target. */
const ATTR = /(\b(?:src|srcset|href)=["']?)([^"'\s>]+)/g;
/** The syntaxes a link is read in; each pattern's second group is the URL. */
const SYNTAXES = [LINK, REF, ATTR];

/** `text`, which holds no code, with its relative links made absolute. */
function absolute(text) {
  return SYNTAXES.reduce(
    (out, syntax) => out.replace(syntax, (_, head, u) => `${head}${abs(u)}`),
    text,
  );
}

/** The SDK's npm README: the root README under `root`, with absolute links outside code. */
export function syncedReadme(root) {
  const md = readFileSync(join(root, 'README.md'), 'utf8');

  return runs(md)
    .map(({ code, text }) => (code ? text : absolute(text)))
    .join('\n');
}

/** Every link and image source in `md` outside code, in each syntax `syncedReadme` rewrites. */
export function links(md) {
  return runs(md)
    .filter(({ code }) => !code)
    .flatMap(({ text }) =>
      SYNTAXES.flatMap((syntax) => [...text.matchAll(syntax)].map((m) => m[2])),
    );
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
