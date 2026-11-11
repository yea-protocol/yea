/**
 * Tests for sync-readme.mjs: the SDK's npm README is in sync today, links in
 * every syntax become absolute, and an edited copy counts as drift.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readmeInSync, syncedReadme } from './sync-readme.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A temp repo whose root README is `readme` and whose ts/README.md is `npm`. */
function repoWith(readme, npm) {
  const root = mkdtempSync(join(tmpdir(), 'yea-readme-'));

  mkdirSync(join(root, 'ts'));
  writeFileSync(join(root, 'README.md'), readme);
  writeFileSync(join(root, 'ts', 'README.md'), npm);

  return root;
}

test("the SDK's npm README is the synced root README", () => {
  assert.ok(readmeInSync(ROOT), 'run node scripts/sync-readme.mjs');
});

test('relative links and images become absolute', () => {
  const root = repoWith('[spec](SPEC.md) <img src="./site/logo.svg">', '');

  assert.equal(
    syncedReadme(root),
    '[spec](https://github.com/yea-protocol/yea/blob/main/SPEC.md) ' +
      '<img src="https://raw.githubusercontent.com/yea-protocol/yea/main/site/logo.svg">',
  );
});

test('reference definitions and anchors become absolute; a footnote stays as it is', () => {
  const readme = [
    '[spec][s] <a href="docs/why.md">why</a> and a note[^1]',
    '',
    '[s]: SPEC.md',
    '[^1]: see the spec',
  ].join('\n');
  const blob = 'https://github.com/yea-protocol/yea/blob/main/';

  assert.equal(
    syncedReadme(repoWith(readme, '')),
    [
      `[spec][s] <a href="${blob}docs/why.md">why</a> and a note[^1]`,
      '',
      `[s]: ${blob}SPEC.md`,
      '[^1]: see the spec',
    ].join('\n'),
  );
});

test('a hand-edited npm README is drift', () => {
  assert.equal(readmeInSync(repoWith('# yea\n', '# yea\n')), true);
  assert.equal(readmeInSync(repoWith('# yea\n', '# yea, edited\n')), false);
});
