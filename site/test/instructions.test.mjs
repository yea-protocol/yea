/**
 * The install and run lines adopters follow work as written (#324). An install line that adds zod
 * pins zod 4: `npm i zod` leaves a zod 3 project on zod 3, and `guard()` needs 4.2 or later. A
 * `node server.ts` for the reader's own file says the project needs `"type": "module"`, since
 * `npm init` writes `"type": "commonjs"`. A page that includes a README region promises code only
 * if the region has some. And the README's quickstart installs what its example imports and the
 * `tsx` its run line uses, and says which folder to add the server from.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { adopterPages, ROOT, units } from './adopter-pages.mjs';

const read = (file) => readFileSync(join(ROOT, file), 'utf8');

/** Each npm install command in `text`, continued lines joined, as the words it installs. */
function installs(text) {
  return text
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => /\bnpm (?:i|install|add) ([^`#\n]*)/.exec(line)?.[1])
    .filter((args) => args !== undefined)
    .map((args) => args.split(/\s+/).filter((w) => w && !w.startsWith('-')));
}

/** The package a word installs: `zod@4` → `zod`, `@scope/pkg@1` → `@scope/pkg`. */
const packageOf = (word) => word.replace(/(.)@.*$/, '$1');

/** The install commands in `text` that add zod without pinning version 4 or later. */
function unpinnedZod(text) {
  return installs(text)
    .filter((words) =>
      words.some((w) => {
        const major = /^zod(?:@[\^~]?(\d+))?$/.exec(w)?.[1];

        return /^zod(@|$)/.test(w) && !(Number(major) >= 4);
      }),
    )
    .map((words) => `npm i ${words.join(' ')}`);
}

/** The units of `text` that run the reader's own `.ts` file with `node` but don't name ESM. */
function nodeWithoutModule(text) {
  return units(text).filter(
    (u) =>
      /\bnode [\w-]+\.ts\b/.test(u) && !/"type": ?"module"|type=module/.test(u),
  );
}

/** The README region `name`, as a page's `<!--@include: ../../README.md#name-->` gets it. */
function region(name) {
  const readme = read('README.md');
  const start = readme.indexOf(`<!-- #region ${name} -->`);
  const end = readme.indexOf(`<!-- #endregion ${name} -->`);

  assert.ok(start >= 0 && end > start, `README.md has no region ${name}`);

  return readme.slice(start, end);
}

const INCLUDE = /<!--@include: \.\.\/\.\.\/README\.md#([\w-]+)-->/g;
const CODE = /^[\s>]*```(?:ts|typescript|js|javascript|py|python)\b/m;

/** Whether `page` says it shows the reader's own code while the regions it includes have none. */
function promisesMissingCode(page, regionOf) {
  const included = [...page.matchAll(INCLUDE)].map((m) => regionOf(m[1]));
  const own = page.replace(INCLUDE, '').replace(/\s+/g, ' ');

  return (
    included.length > 0 &&
    /\byour own code\b/i.test(own) &&
    !included.some((r) => CODE.test(r))
  );
}

/** Each adopter page's findings from `check`, as `path: finding`. */
const onAdopterPages = (check) =>
  adopterPages().flatMap((f) =>
    check(readFileSync(f, 'utf8')).map((x) => `${relative(ROOT, f)}: ${x}`),
  );

test('an install line that adds zod pins zod 4', () => {
  assert.deepEqual(unpinnedZod('npm i @modelcontextprotocol/server zod'), [
    'npm i @modelcontextprotocol/server zod',
  ]);
  assert.deepEqual(unpinnedZod('npm i a.tgz \\\n  zod@^3.25 tsx'), [
    'npm i a.tgz zod@^3.25 tsx',
  ]);
  assert.deepEqual(unpinnedZod('`npm i zod@4`, then `npm i zod-to-x`'), []);
  assert.deepEqual(unpinnedZod('npm i @modelcontextprotocol/server zod@4'), []);

  assert.deepEqual(onAdopterPages(unpinnedZod), []);
});

test('`node server.ts` says the project needs "type": "module"', () => {
  const offer = '`node server.ts` works in place of `npx tsx server.ts`';

  assert.deepEqual(nodeWithoutModule(offer), [offer]);
  assert.deepEqual(
    nodeWithoutModule(`${offer} when package.json has "type": "module".`),
    [],
  );
  // From a clone, the repo's package.json already says it.
  assert.deepEqual(nodeWithoutModule('Run `node examples/demo.ts`.'), []);

  assert.deepEqual(onAdopterPages(nodeWithoutModule), []);
});

test('a page promises your own code only if the README regions it includes have some', () => {
  const regions = { sh: '```sh\nyea demo\n```', ts: '```ts\nconnect()\n```' };
  const regionOf = (name) => regions[name];
  const page = (name) =>
    `Run it, then in your own code.\n\n<!--@include: ../../README.md#${name}-->`;

  assert.equal(promisesMissingCode(page('sh'), regionOf), true);
  assert.equal(promisesMissingCode(page('ts'), regionOf), false);
  assert.equal(promisesMissingCode('In your own code.', region), false);

  const guides = adopterPages().filter((f) =>
    f.includes(join('site', 'guide')),
  );
  const broken = guides
    .filter((f) => promisesMissingCode(readFileSync(f, 'utf8'), region))
    .map((f) => relative(ROOT, f));

  assert.ok(guides.some((f) => f.endsWith('quickstart.md')));
  assert.deepEqual(broken, []);
});

test("the README's quickstart installs what it imports and runs, and says where to add it", () => {
  const readme = read('README.md');
  const top = readme.slice(0, readme.indexOf('\n## Get started'));
  const [install = []] = installs(top);
  const installed = install.map(packageOf);
  const imported = [
    ...read('examples/guard-quickstart.ts').matchAll(/ from '([^']+)'/g),
  ]
    .map((m) => m[1].match(/^(@[^/]+\/)?[^/]+/)?.[0] ?? m[1])
    .filter((p) => !p.startsWith('node:'));
  const run = units(top).find((u) => u.includes('claude mcp add'));

  assert.deepEqual(
    imported.filter((p) => !installed.includes(p)),
    [],
    `the install line (${install.join(' ')}) misses an import`,
  );
  assert.ok(imported.includes('zod') && imported.includes('@yea-protocol/mcp'));
  assert.match(run ?? '', /`claude mcp add mail -- npx tsx server\.ts`/);
  assert.ok(installed.includes('tsx'), 'the run line uses tsx: install it');
  assert.match(
    (run ?? '').replace(/\s+/g, ' '),
    /\bfolder\b/,
    'say which folder to run `claude mcp add` in',
  );
});
