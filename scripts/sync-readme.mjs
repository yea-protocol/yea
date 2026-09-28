/**
 * Copies the root README into ts/ (npm) with relative links made absolute, so the npm
 * page renders images and links correctly. Runs before `npm publish`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const RAW = 'https://raw.githubusercontent.com/yea-protocol/yea/main/';
const BLOB = 'https://github.com/yea-protocol/yea/blob/main/';
const isRel = (u) => !/^(https?:|#|mailto:)/.test(u);
const isImg = (u) => /\.(svg|png|jpe?g|gif)$/i.test(u);
const abs = (u) =>
  isRel(u) ? (isImg(u) ? RAW : BLOB) + u.replace(/^\.\//, '') : u;

let md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

md = md.replace(/\]\(([^)\s]+)\)/g, (_, u) => `](${abs(u)})`);
md = md.replace(/(src|srcset)="([^"]+)"/g, (_, a, u) => `${a}="${abs(u)}"`);
writeFileSync(new URL('../ts/README.md', import.meta.url), md);
console.log('ts/README.md synced');
