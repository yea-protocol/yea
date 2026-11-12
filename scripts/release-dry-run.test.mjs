/**
 * Tests for release-dry-run.mjs's checks that run without packing: a broken
 * `exports` path or a missing `exports` fails the exports check, a file left
 * out of a tarball fails the tarball check, a bin that fails or prints no help
 * fails the bin check, release.yml must publish every package that isn't
 * private, a tarball needs a README and, given a tag, a packed README (npm's
 * or an sdist's) can't say it's unreleased however it's worded, and the
 * `initialize` probe tells a server that answers from one that errs, exits or
 * hangs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { binProblems, binsOf } from './release-dry-run/bins.mjs';
import { exportProblems } from './release-dry-run/exports.mjs';
import { initialize } from './release-dry-run/mcp-initialize.mjs';
import { packedProblems } from './release-dry-run/npm.mjs';
import { publishedPackages, unreleased } from './release-dry-run/packages.mjs';
import { sdistProblems } from './release-dry-run/python.mjs';
import { missingReadmes, unreleasedReadme } from './release-dry-run/readme.mjs';
import { unpackedFiles } from './release-dry-run/tarball.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A project with package `fixture` installed, whose `exports` is `exports`. */
function projectWith(exports) {
  const app = mkdtempSync(join(tmpdir(), 'yea-exports-'));
  const dir = join(app, 'node_modules', 'fixture');

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', type: 'module', exports }),
  );
  writeFileSync(join(dir, 'index.js'), 'export const ok = true;\n');
  writeFileSync(join(dir, 'index.d.ts'), 'export declare const ok: true;\n');

  return app;
}

/** A workspace at a temp folder whose `files` are `files`, with dist/a.js and dist/sub/b.js. */
function workspaceWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'yea-tarball-'));

  mkdirSync(join(dir, 'dist', 'sub'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'w', files }),
  );
  writeFileSync(join(dir, 'dist', 'a.js'), '');
  writeFileSync(join(dir, 'dist', 'sub', 'b.js'), '');

  return dir;
}

/**
 * An archive at a temp folder holding `files` (path to text), made with tar as npm and uv do,
 * named `name`.
 */
function archiveWith(files, name = 'packed.tgz') {
  const dir = mkdtempSync(join(tmpdir(), 'yea-archive-'));
  const archive = join(dir, name);

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, 'src', dirname(path)), { recursive: true });
    writeFileSync(join(dir, 'src', path), text);
  }

  execFileSync('tar', [
    '-czf',
    archive,
    '-C',
    join(dir, 'src'),
    ...Object.keys(files),
  ]);

  return archive;
}

/**
 * A project with package `tool` installed, whose bin `tool` runs `code` (a
 * Node script body), linked into node_modules/.bin as npm links it.
 */
function projectWithBin(code) {
  const app = mkdtempSync(join(tmpdir(), 'yea-bins-'));
  const dir = join(app, 'node_modules', 'tool');
  const bin = join(app, 'node_modules', '.bin', 'tool');

  mkdirSync(dir, { recursive: true });
  mkdirSync(join(app, 'node_modules', '.bin'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'tool', bin: { tool: 'cli.js' } }),
  );
  writeFileSync(bin, `#!/usr/bin/env node\n${code}\n`);
  chmodSync(bin, 0o755);

  return app;
}

/** A server that runs `body` on each stdin line, as `node -e` code. */
function server(body) {
  return [
    '-e',
    `require('readline').createInterface({ input: process.stdin })
      .on('line', (line) => { const req = JSON.parse(line); ${body} });`,
  ];
}

/** The banner line the packed READMEs carry before a release. */
const BANNER = '> **Unreleased:** not on npm yet.';

/** What an unreleased README's line in a check says. */
const SAYS = "its README still says it isn't released";

/**
 * A repo whose release.yml packs and publishes @yea-protocol/a, from a/, and
 * a's pack, whose README is `readme` (none if undefined).
 */
function packedRepo(readme) {
  const root = mkdtempSync(join(tmpdir(), 'yea-packed-'));
  const files = { 'package/dist/index.js': '' };

  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'a', 'dist'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'workflows', 'release.yml'),
    'npm pack -w @yea-protocol/a\nnpm publish npm-dist/yea-protocol-a-*.tgz\n',
  );
  writeFileSync(
    join(root, 'a', 'package.json'),
    JSON.stringify({ name: '@yea-protocol/a', files: ['dist'] }),
  );
  writeFileSync(join(root, 'a', 'dist', 'index.js'), '');

  if (readme !== undefined) {
    files['package/README.md'] = readme;
  }

  const paths = Object.keys(files).map((p) => p.replace('package/', ''));
  const pack = {
    name: '@yea-protocol/a',
    dir: 'a',
    tarball: archiveWith(files),
    paths: [...paths, 'package.json'],
  };

  return { root, packages: [{ name: pack.name, dir: 'a' }], packs: [pack] };
}

const REPLY =
  'console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { serverInfo: { name: "fake" } } }));';

test('exports that all resolve and load pass', () => {
  const app = projectWith({
    '.': { types: './index.d.ts', default: './index.js' },
  });

  assert.deepEqual(exportProblems(app, 'fixture'), []);
});

test('a broken exports path fails, naming the entry and the file', () => {
  const app = projectWith({
    '.': './index.js',
    './broken': { types: './index.d.ts', default: './dist/missing.js' },
  });
  const problems = exportProblems(app, 'fixture');

  assert.equal(
    problems[0],
    "fixture/broken: ./dist/missing.js isn't in the package",
  );
  assert.match(problems[1], /^import fixture\/broken: .*ERR_MODULE_NOT_FOUND/);
  assert.match(problems[2], /^require fixture\/broken: .*Cannot find module/);
  assert.equal(problems.length, 3);
});

test('a missing types file fails even though the code loads', () => {
  const app = projectWith({
    '.': { types: './index.d.mts', default: './index.js' },
  });

  assert.deepEqual(exportProblems(app, 'fixture'), [
    "fixture: ./index.d.mts isn't in the package",
  ]);
});

test('a package without exports fails', () => {
  assert.throws(
    () => exportProblems(projectWith(undefined), 'fixture'),
    /fixture has no exports/,
  );
});

test('a tarball with every file under its files folders passes', () => {
  const dir = workspaceWith(['dist', 'README.md']);

  assert.deepEqual(
    unpackedFiles(dir, ['dist/a.js', 'dist/sub/b.js', 'package.json']),
    [],
  );
});

test('a file a tarball left out is named', () => {
  const dir = workspaceWith(['dist']);

  assert.deepEqual(unpackedFiles(dir, ['dist/a.js', 'package.json']), [
    "w: dist/sub/b.js isn't in the tarball",
  ]);
});

test('a tarball without a README is named', () => {
  const packs = [
    { name: 'a', paths: ['README.md', 'package.json'] },
    { name: 'b', paths: ['dist/index.js', 'package.json'] },
  ];

  assert.deepEqual(missingReadmes(packs), ['b: the tarball has no README.md']);
});

test('a packed README that says Unreleased fails, naming its lines', () => {
  const archive = archiveWith({
    'package/README.md': `# a\n\n${BANNER}\n`,
    'package/index.js': '',
  });

  assert.deepEqual(unreleasedReadme('a', archive, 'package/README.md'), [
    `a: ${SAYS} (line 3); take the banners out before the tag`,
  ]);
});

test('a packed README that says it is unreleased in other words fails too', () => {
  const lines = [
    '> **UNRELEASED:** soon.',
    'Still unreleased.',
    '> **Pre-release:** nothing on npm yet.',
    '> **Not yet released.**',
    "`yea-x` isn't on PyPI yet.",
    'The SDKs aren’t on npm or PyPI yet.',
    'Not on npm yet.',
    'A prerelease build.',
    "Once they're published, each SDK installs with one command:",
    'The install fails until it’s published.',
    'Install it once it is published.',
    'Released under Apache-2.0; see the release notes.',
    'A version, once published, can’t change.',
  ];
  const archive = archiveWith({ 'package/README.md': lines.join('\n') });

  assert.deepEqual(unreleasedReadme('a', archive, 'package/README.md'), [
    `a: ${SAYS} (line 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11); take the banners out before the tag`,
  ]);
});

test('a packed README without the banner passes, in an sdist too', () => {
  const archive = archiveWith({ 'yea_x-0.1.0/README.md': '# yea-x\n' });

  assert.deepEqual(
    unreleasedReadme('yea_x-0.1.0', archive, 'yea_x-0.1.0/README.md'),
    [],
  );
});

test('given a tag, the npm step fails on a packed README with the banner', () => {
  const { root, packages, packs } = packedRepo(`# a\n${BANNER}\n`);

  assert.deepEqual(packedProblems(root, packages, packs, 'v0.1.0'), [
    `@yea-protocol/a: ${SAYS} (line 2); take the banners out before the tag`,
  ]);
  assert.deepEqual(packedProblems(root, packages, packs, undefined), []);
});

test('the npm step names a tarball without a README, with or without a tag', () => {
  const { root, packages, packs } = packedRepo(undefined);
  const missing = ['@yea-protocol/a: the tarball has no README.md'];

  assert.deepEqual(packedProblems(root, packages, packs, 'v0.1.0'), missing);
  assert.deepEqual(packedProblems(root, packages, packs, undefined), missing);
});

test('the npm step lists every problem at once', () => {
  const { root, packs } = packedRepo(`${BANNER}\n`);
  const packages = [
    { name: '@yea-protocol/a', dir: 'a' },
    { name: '@yea-protocol/new', dir: 'new' },
  ];

  writeFileSync(join(root, 'a', 'dist', 'more.js'), '');

  assert.deepEqual(packedProblems(root, packages, packs, 'v0.1.0'), [
    "release.yml doesn't pack @yea-protocol/new",
    "release.yml doesn't publish @yea-protocol/new",
    "@yea-protocol/a: dist/more.js isn't in the tarball",
    `@yea-protocol/a: ${SAYS} (line 1); take the banners out before the tag`,
  ]);
});

test('given a tag, the Python step fails on an sdist whose README has the banner', () => {
  const sdist = archiveWith(
    { 'yea_x-0.1.0/README.md': `# yea-x\n${BANNER}\n` },
    'yea_x-0.1.0.tar.gz',
  );
  const dist = dirname(sdist);

  writeFileSync(join(dist, 'yea_x-0.1.0-py3-none-any.whl'), '');

  assert.deepEqual(sdistProblems(dist, 'v0.1.0'), [
    `yea_x-0.1.0: ${SAYS} (line 2); take the banners out before the tag`,
  ]);
  assert.deepEqual(sdistProblems(dist, undefined), []);
});

test('a bin that prints its usage line passes', () => {
  const app = projectWithBin('console.log("usage: tool [--help]")');

  assert.deepEqual(binsOf(app, 'tool'), ['tool']);
  assert.deepEqual(binProblems(app, 'tool'), []);
});

test('a bin that prints its help to stderr passes', () => {
  const app = projectWithBin('console.error("usage: tool [--help]")');

  assert.deepEqual(binProblems(app, 'tool'), []);
});

test('a bin whose link is missing fails', () => {
  const app = projectWithBin('');

  assert.match(binProblems(app, 'absent')[0], /^absent --help: .*ENOENT/);
});

test('a bin that exits 1 fails', () => {
  const app = projectWithBin(
    'console.error("Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: no"); process.exit(1)',
  );

  assert.deepEqual(binProblems(app, 'tool'), [
    'tool --help exited 1: Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: no',
  ]);
});

test('a bin that prints a stack trace and exits 0 fails', () => {
  const app = projectWithBin(
    'console.log(new Error("broken").stack); process.exit(0)',
  );

  assert.deepEqual(binProblems(app, 'tool'), [
    'tool --help printed no usage line: Error: broken',
  ]);
});

test('the published packages are the workspaces that are not private', () => {
  assert.deepEqual(
    publishedPackages(ROOT)
      .map(({ name }) => name)
      .sort(),
    [
      '@yea-protocol/cli',
      '@yea-protocol/mcp',
      '@yea-protocol/sdk',
      '@yea-protocol/stripe',
    ],
  );
});

test('release.yml packs and publishes every published package', () => {
  const workflow = readFileSync(
    join(ROOT, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const extra = { name: '@yea-protocol/new', dir: 'connectors/new' };

  assert.deepEqual(unreleased(workflow, publishedPackages(ROOT)), []);
  assert.deepEqual(unreleased(workflow, [extra]), [
    "release.yml doesn't pack @yea-protocol/new",
    "release.yml doesn't publish @yea-protocol/new",
  ]);
});

test('initialize resolves with the serverInfo a server answers with', async () => {
  assert.deepEqual(await initialize(process.execPath, server(REPLY)), {
    name: 'fake',
  });
});

test('initialize rejects an error reply', async () => {
  const body =
    'console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32600, message: "no" } }));';

  await assert.rejects(
    initialize(process.execPath, server(body)),
    /initialize failed/,
  );
});

test('initialize rejects a server that exits first, with its stderr', async () => {
  const args = ['-e', 'console.error("no home"); process.exit(3)'];

  await assert.rejects(
    initialize(process.execPath, args),
    /exited \(3\)[\s\S]*no home/,
  );
});

test('initialize rejects a server that never answers', async () => {
  await assert.rejects(
    initialize(process.execPath, server(''), { timeoutMs: 200 }),
    /no answer in 200 ms/,
  );
});
