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
  findViolations,
  MAX_LINES,
  report,
} from './check-structure.mjs';

const HEADER = '/** A module. */\n';
const DOC = '"""A module."""\n';
const root = mkdtempSync(join(tmpdir(), 'check-structure-'));

after(() => rmSync(root, { recursive: true, force: true }));

/** Writes `files` ({ path: text }) under a fresh folder and returns its name. */
function fixture(name, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, name, path);

    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }

  return name;
}

/** The rules `path` breaks, given its text. */
function rules(path, text) {
  return checkFile(path, text).map((v) => v.rule);
}

test('header: TS and JS open with a block comment, after any shebang', () => {
  assert.deepEqual(rules('a.ts', `${HEADER}export {};\n`), []);
  assert.deepEqual(rules('a.mjs', `#!/usr/bin/env node\n${HEADER}`), []);
  assert.deepEqual(rules('a.ts', '/*\n * Block.\n */\n'), []);
  assert.deepEqual(rules('a.ts', '// A line comment.\nexport {};\n'), [
    'header',
  ]);
  assert.deepEqual(rules('a.js', `import 'x';\n${HEADER}`), ['header']);
});

test('header: Vue opens with a comment, or its script does', () => {
  const inScript = `<script setup lang="ts">\n${HEADER}</script>\n`;

  assert.deepEqual(rules('Page.vue', inScript), []);
  assert.deepEqual(rules('Page.vue', '<!-- A page. -->\n<template/>\n'), []);
  assert.deepEqual(rules('Page.vue', '<script setup>\nconst a = 1;\n'), [
    'header',
  ]);
  assert.deepEqual(rules('Page.vue', '<template/>\n'), ['header']);
});

test('header: Python modules start with their docstring', () => {
  const preamble = '#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n\n';

  assert.deepEqual(rules('a.py', DOC), []);
  assert.deepEqual(rules('a.py', `${preamble}${DOC}`), []);
  assert.deepEqual(
    rules('a.py', `from __future__ import annotations\n${DOC}`),
    ['header'],
  );
  assert.deepEqual(rules('a.py', '# A comment.\nx = 1\n'), ['header']);
  assert.deepEqual(rules('a.py', ''), ['header']);
});

test(`length: at most ${MAX_LINES} lines`, () => {
  const body = (n) => HEADER + 'x;\n'.repeat(n - 1);

  assert.deepEqual(rules('a.ts', body(MAX_LINES)), []);
  assert.deepEqual(rules('a.ts', body(MAX_LINES + 1)), ['length']);
});

test('name: kebab-case TS/JS, snake_case Python, PascalCase Vue', () => {
  const vue = `<!-- A page. -->\n`;

  for (const ok of ['serve-fetch.ts', 'b64.ts', 'x.d.ts', 'cli.mjs']) {
    assert.deepEqual(rules(ok, HEADER), [], ok);
  }

  for (const bad of ['serveFetch.ts', 'Serve.ts', 'serve_fetch.js']) {
    assert.deepEqual(rules(bad, HEADER), ['name'], bad);
  }

  assert.deepEqual(rules('_json.py', DOC), []);
  assert.deepEqual(rules('Client.py', DOC), ['name']);
  assert.deepEqual(rules('PlayGround.vue', vue), []);
  assert.deepEqual(rules('playground.vue', vue), ['name']);
});

test('the walk skips tests, dependencies, build output and other files', () => {
  const dir = fixture('walk', {
    'src/ok.ts': HEADER,
    'src/bad.ts': 'export {};\n',
    'src/bad.test.ts': 'export {};\n',
    'src/test/bad.ts': 'export {};\n',
    'src/node_modules/bad.ts': 'export {};\n',
    'src/dist/bad.js': 'export {};\n',
    'src/style.css': 'a {}\n',
    'pkgs/one/src/bad.py': 'x = 1\n',
  });
  const found = findViolations(join(root, dir), ['src', 'pkgs/*/src', 'none']);

  assert.deepEqual(found.map((v) => `${v.path}: ${v.rule}`).sort(), [
    'pkgs/one/src/bad.py: header',
    'src/bad.ts: header',
  ]);
});

test('ratchet: listed violations pass, unlisted ones fail', () => {
  const found = [
    { path: 'a.ts', rule: 'length', detail: '301 > 300' },
    { path: 'a.ts', rule: 'name', detail: 'lowercase words joined with -' },
  ];
  const result = compare(found, { 'a.ts': ['length'] });

  assert.deepEqual(result.fixed, []);
  assert.deepEqual(report(result), [
    'a.ts: name (lowercase words joined with -)',
  ]);
});

test('ratchet: a listed violation that no longer occurs fails', () => {
  const found = [{ path: 'a.ts', rule: 'length', detail: '301 > 300' }];
  const result = compare(found, { 'a.ts': ['length'], 'b.ts': ['name'] });

  assert.deepEqual(result.unlisted, []);
  assert.deepEqual(report(result), [
    'b.ts: name (no longer occurs: remove it from the ratchet)',
  ]);
});
