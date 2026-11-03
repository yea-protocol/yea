/**
 * Tests for release-dry-run.mjs's checks that run without packing: a broken
 * `exports` path fails the exports check, and the `initialize` probe tells a
 * server that answers from one that errs, exits or hangs.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportProblems } from './release-dry-run/exports.mjs';
import { initialize } from './release-dry-run/mcp-initialize.mjs';

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

/** A server that runs `body` on each stdin line, as `node -e` code. */
function server(body) {
  return [
    '-e',
    `require('readline').createInterface({ input: process.stdin })
      .on('line', (line) => { const req = JSON.parse(line); ${body} });`,
  ];
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
