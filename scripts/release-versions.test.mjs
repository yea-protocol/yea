/**
 * Tests for release-versions.mjs: the repo agrees today, `setVersion` bumps
 * every place but CHANGELOG, and `disagreements` names a place left behind.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  currentVersion,
  disagreements,
  SITES,
  setVersion,
  tagProblems,
} from './release-versions.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A temp copy of every file a version lives in. */
function copyOfSites() {
  const dir = mkdtempSync(join(tmpdir(), 'yea-versions-'));

  for (const { file } of SITES) {
    cpSync(join(ROOT, file), join(dir, file));
  }

  return dir;
}

/** Rewrites `file` under `dir` with `change`. */
function edit(dir, file, change) {
  const path = join(dir, file);

  writeFileSync(path, change(readFileSync(path, 'utf8')));
}

test('every version in the repo agrees', () => {
  assert.deepEqual(disagreements(ROOT), []);
});

test('setVersion bumps every place but the CHANGELOG heading', () => {
  const dir = copyOfSites();

  setVersion(dir, '9.8.7');

  assert.equal(currentVersion(dir), '9.8.7');
  assert.deepEqual(disagreements(dir), [
    `CHANGELOG.md (top heading): ${currentVersion(ROOT)}, expected 9.8.7`,
  ]);

  edit(dir, 'CHANGELOG.md', (t) => t.replace(/^## v\S+/m, '## v9.8.7:'));
  assert.deepEqual(disagreements(dir), []);
});

test('a version left behind is named', () => {
  const dir = copyOfSites();

  setVersion(dir, '9.8.7');
  edit(dir, 'CHANGELOG.md', (t) => t.replace(/^## v\S+/m, '## v9.8.7:'));
  edit(dir, 'cli/package.json', (t) =>
    t.replace('"@yea-protocol/mcp": "9.8.7"', '"@yea-protocol/mcp": "9.8.6"'),
  );

  assert.deepEqual(disagreements(dir), [
    'cli/package.json (sibling ranges): 9.8.6, expected 9.8.7',
  ]);
});

test('a place the version has gone missing from is named', () => {
  const dir = copyOfSites();

  edit(dir, 'server.json', (t) => t.replaceAll('"version"', '"v"'));

  assert.deepEqual(disagreements(dir), ['server.json (versions): not found']);
});

test('setVersion writes nothing when a place has gone missing', () => {
  const dir = copyOfSites();

  edit(dir, 'server.json', (t) => t.replaceAll('"version"', '"v"'));

  assert.throws(
    () => setVersion(dir, '9.8.7'),
    /server\.json \(versions\): not found/,
  );
  assert.equal(currentVersion(dir), currentVersion(ROOT));
});

test('an "Unreleased" top heading disagrees', () => {
  const dir = copyOfSites();

  edit(dir, 'CHANGELOG.md', (t) => t.replace(/^## /m, '## Unreleased\n\n## '));

  assert.match(disagreements(dir).join('\n'), /top heading\): Unreleased/);
});

test('setVersion refuses anything but x.y.z', () => {
  for (const bad of ['0.2', 'v0.2.0', '0.2.0-rc.1', '']) {
    assert.throws(() => setVersion(copyOfSites(), bad), /release version/);
  }
});

test('a release tag must be v and the version', () => {
  assert.deepEqual(tagProblems('v0.2.0', '0.2.0'), []);
  assert.deepEqual(tagProblems('v0.2.0', '0.1.0'), [
    "tag v0.2.0 isn't v0.1.0, the version every package holds",
  ]);
  assert.equal(tagProblems('0.1.0', '0.1.0').length, 1);
});

test('set says why it refuses a version', () => {
  const script = fileURLToPath(
    new URL('release-versions.mjs', import.meta.url),
  );
  const run = spawnSync(process.execPath, [script, 'set', '0.2'], {
    encoding: 'utf8',
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /"0\.2" isn't a release version \(x\.y\.z\)/);
});
