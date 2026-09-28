/**
 * Tests for check-structure.mjs: each rule (header, length, name), what the
 * walk skips, and the ratchet in both directions.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import {
  checkFile,
  compare,
  expand,
  findViolations,
  MAX_LINES,
  report,
} from './check-structure.mjs';

const HEADER = '/** A module. */\n\n';
const DOC = '"""A module."""\n';
const BAD = 'export {};\n';
const root = mkdtempSync(join(tmpdir(), 'check-structure-'));

after(() => rmSync(root, { recursive: true, force: true }));

/** Writes `files` ({ path: text }) under a fresh folder and returns its path. */
function fixture(name, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, name, path);

    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }

  return join(root, name);
}

/** The rules `path` breaks, given its text. */
function rules(path, text) {
  return checkFile(path, text).map((v) => v.rule);
}

/** `path: rule` for each violation under `roots` in the fixture `dir`. */
function found(dir, roots) {
  return findViolations(dir, roots).map((v) => `${v.path}: ${v.rule}`);
}

test('header: TS and JS open with a /** comment, after any shebang', () => {
  assert.deepEqual(rules('a.ts', `${HEADER}export {};\n`), []);
  assert.deepEqual(rules('a.mjs', `#!/usr/bin/env node\n${HEADER}`), []);
  assert.deepEqual(rules('a.ts', '/**\n * A module.\n */\nimport x;\n'), []);
  assert.deepEqual(rules('a.ts', '/* Not a doc comment. */\n'), ['header']);
  assert.deepEqual(rules('a.ts', '// A line comment.\n'), ['header']);
  assert.deepEqual(rules('a.js', `import 'x';\n${HEADER}`), ['header']);
});

test('header: a comment directly above a declaration is its JSDoc', () => {
  for (const decl of [
    'export function f() {}',
    'const a = 1;',
    'type T = 1;',
  ]) {
    assert.deepEqual(rules('a.ts', `/** f. */\n${decl}\n`), ['header'], decl);
    assert.deepEqual(rules('a.ts', `/** f. */ ${decl}\n`), ['header'], decl);
    assert.deepEqual(rules('a.ts', `/** A module. */\n\n${decl}\n`), [], decl);
  }
});

test('header: a Vue component opens its <script> with one', () => {
  const inScript = `<script setup lang="ts">\n${HEADER}</script>\n`;

  assert.deepEqual(rules('Page.vue', inScript), []);
  assert.deepEqual(rules('Page.vue', '<!-- A page. -->\n<template/>\n'), [
    'header',
  ]);
  assert.deepEqual(rules('Page.vue', '<script setup>\nconst a = 1;\n'), [
    'header',
  ]);
});

test('header: Python modules start with their docstring', () => {
  const preamble = '#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n\n';

  assert.deepEqual(rules('a.py', DOC), []);
  assert.deepEqual(rules('a.py', `${preamble}${DOC}`), []);
  assert.deepEqual(rules('a.py', `# Licensed under Apache-2.0.\n${DOC}`), []);
  assert.deepEqual(
    rules('a.py', `from __future__ import annotations\n${DOC}`),
    ['header'],
  );
  assert.deepEqual(rules('a.py', '# A comment.\nx = 1\n'), ['header']);
  assert.deepEqual(rules('a.py', ''), ['header']);
});

test(`length: at most ${MAX_LINES} lines, except bench and vectors`, () => {
  const body = (n) => HEADER + 'x;\n'.repeat(n - 2);
  const long = body(MAX_LINES + 1);

  assert.deepEqual(rules('a.ts', body(MAX_LINES)), []);
  assert.deepEqual(rules('a.ts', long), ['length']);
  assert.deepEqual(rules('bench/run.ts', long), []);
  assert.deepEqual(rules('ts/scripts/vectors.mjs', long), []);
  assert.deepEqual(rules('ts/scripts/other.mjs', long), ['length']);
});

test('name: kebab-case TS/JS, snake_case Python, PascalCase Vue', () => {
  const vue = `<script>\n${HEADER}</script>\n`;

  for (const ok of ['serve-fetch.ts', 'b64.ts', 'index.d.ts', 'cli.mjs']) {
    assert.deepEqual(rules(ok, HEADER), [], ok);
  }

  for (const bad of ['serveFetch.ts', 'Serve.ts', 'x_y.js', 'Index.d.ts']) {
    assert.deepEqual(rules(bad, HEADER), ['name'], bad);
  }

  assert.deepEqual(rules('_json.py', DOC), []);
  assert.deepEqual(rules('Client.py', DOC), ['name']);
  assert.deepEqual(rules('PlayGround.vue', vue), []);
  assert.deepEqual(rules('playground.vue', vue), ['name']);
});

test('name: known run-together words are named', () => {
  for (const joined of ['servefetch.ts', 'keyfile.ts', 'testdrive.d.ts']) {
    assert.deepEqual(rules(joined, HEADER), ['name'], joined);
  }

  assert.deepEqual(rules('key-file.ts', HEADER), []);
});

test('the walk skips tests, dependencies, build output and other files', () => {
  const dir = fixture('walk', {
    'src/ok.ts': HEADER,
    'src/bad.ts': BAD,
    'src/bad.test.ts': BAD,
    'src/node_modules/bad.ts': BAD,
    'src/dist/bad.js': BAD,
    'src/cache/bad.ts': BAD,
    'src/style.css': 'a {}\n',
    'pkgs/one/src/bad.py': 'x = 1\n',
  });

  assert.deepEqual(found(dir, ['src', 'pkgs/*/src', 'none', 'none/*/src']), [
    'pkgs/one/src/bad.py: header',
    'src/bad.ts: header',
    'src/cache/bad.ts: header',
  ]);
});

test('the walk skips VitePress output by path, not by name', () => {
  const dir = fixture('site', {
    'site/.vitepress/config.ts': BAD,
    'site/.vitepress/cache/deps/a.js': BAD,
    'site/.vitepress/dist/a.js': BAD,
    'site/.vitepress/.temp/a.js': BAD,
    'site/.vitepress/theme/cache/a.ts': BAD,
  });

  assert.deepEqual(found(dir, ['site/.vitepress']), [
    'site/.vitepress/config.ts: header',
    'site/.vitepress/theme/cache/a.ts: header',
  ]);
});

test('roots: only one whole middle segment may be *', () => {
  for (const bad of ['*/src', 'src/*', 'a/*/b/*/c', 'a/b*/c']) {
    assert.throws(() => expand(root, bad), /unsupported root/, bad);
  }
});

test('ratchet: listed violations pass, unlisted ones fail', () => {
  const violations = [
    { path: 'a.ts', rule: 'length', detail: '301 > 300' },
    { path: 'a.ts', rule: 'name', detail: 'lowercase words joined with -' },
  ];
  const result = compare(violations, { 'a.ts': ['length'] });

  assert.deepEqual(result.fixed, []);
  assert.deepEqual(report(result), [
    'a.ts: name (lowercase words joined with -)',
  ]);
});

test('ratchet: a listed violation that no longer occurs fails', () => {
  const violations = [{ path: 'a.ts', rule: 'length', detail: '301 > 300' }];
  const result = compare(violations, { 'a.ts': ['length', 'name'] });

  assert.deepEqual(result.unlisted, []);
  assert.deepEqual(report(result), [
    'a.ts: name (no longer occurs: remove it from the ratchet)',
  ]);
});

test('ratchet: an entry for a file renamed away fails', () => {
  const dir = fixture('renamed', { 'src/serve-fetch.ts': HEADER });
  const result = compare(findViolations(dir, ['src']), {
    'src/servefetch.ts': ['name'],
  });

  assert.deepEqual(report(result), [
    'src/servefetch.ts: name (no longer occurs: remove it from the ratchet)',
  ]);
});
