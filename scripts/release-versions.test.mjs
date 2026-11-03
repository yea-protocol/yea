/**
 * Tests for release-versions.mjs: the repo agrees today, every published
 * package is a place the version lives, `setVersion` bumps every place but
 * CHANGELOG, a place left behind is named, CHANGELOG may say `Unreleased`
 * only between releases, and a release tag must name the version.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishedPackages } from './release-dry-run/packages.mjs';
import {
  currentVersion,
  releaseProblems,
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

/** Sets the top heading of CHANGELOG.md under `dir` to `## heading`. */
function topHeading(dir, heading) {
  edit(dir, 'CHANGELOG.md', (t) => t.replace(/^## .*$/m, `## ${heading}`));
}

/** A temp copy bumped to 9.8.7, CHANGELOG heading included. */
function released() {
  const dir = copyOfSites();

  setVersion(dir, '9.8.7');
  topHeading(dir, 'v9.8.7: a release');

  return dir;
}

test('every version in the repo agrees', () => {
  assert.deepEqual(releaseProblems(ROOT), []);
});

test('every published package is a place the version lives', () => {
  for (const { dir } of publishedPackages(ROOT)) {
    const file = `${dir}/package.json`;

    assert.ok(
      SITES.some((s) => s.file === file && s.what === 'version'),
      file,
    );
  }
});

test('setVersion bumps every place but the CHANGELOG heading', () => {
  const dir = copyOfSites();

  setVersion(dir, '9.8.7');

  assert.equal(currentVersion(dir), '9.8.7');

  const [only, ...rest] = releaseProblems(dir, 'v9.8.7');

  assert.match(only, /^CHANGELOG\.md \(top heading\): .+, expected 9\.8\.7$/);
  assert.deepEqual(rest, []);

  topHeading(dir, 'v9.8.7: a release');
  assert.deepEqual(releaseProblems(dir, 'v9.8.7'), []);
});

test('a version left behind is named', () => {
  const dir = released();

  edit(dir, 'cli/package.json', (t) =>
    t.replace('"@yea-protocol/mcp": "9.8.7"', '"@yea-protocol/mcp": "9.8.6"'),
  );

  assert.deepEqual(releaseProblems(dir, 'v9.8.7'), [
    'cli/package.json (sibling ranges): 9.8.6, expected 9.8.7',
  ]);
});

test('a place the version has gone missing from is named', () => {
  const dir = copyOfSites();

  edit(dir, 'server.json', (t) => t.replaceAll('"version"', '"v"'));

  assert.deepEqual(releaseProblems(dir), ['server.json (versions): not found']);
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

test('CHANGELOG may open with "Unreleased" between releases, not at one', () => {
  const dir = released();

  topHeading(dir, 'Unreleased');

  assert.deepEqual(releaseProblems(dir), []);
  assert.deepEqual(releaseProblems(dir, 'v9.8.7'), [
    'CHANGELOG.md (top heading): Unreleased, expected 9.8.7',
  ]);
});

test('a heading for another version fails even between releases', () => {
  const dir = released();

  topHeading(dir, 'v9.8.6: the last release');

  assert.deepEqual(releaseProblems(dir), [
    'CHANGELOG.md (top heading): 9.8.6, expected 9.8.7',
  ]);
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
  assert.deepEqual(releaseProblems(released(), 'v9.8.6'), [
    "tag v9.8.6 isn't v9.8.7, the version every package holds",
  ]);
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
