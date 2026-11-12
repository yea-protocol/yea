/**
 * Tests for sync-readme.mjs: the SDK's npm README is in sync today, links in
 * each syntax it reads become absolute while code is copied as it is, and an
 * edited copy counts as drift.
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

test('titles, quotes and a definition on two lines keep their shape', () => {
  const readme = [
    '[spec](SPEC.md "the spec") <a href=\'docs/why.md\'>why</a> <a href=LICENSE>l</a>',
    '',
    '> [s]: docs/a.md',
    '[t]:',
    '  docs/b.md "B"',
    '[u]: <docs/c.md>',
    '',
    '[Note]: this is prose, not a definition',
  ].join('\n');
  const blob = 'https://github.com/yea-protocol/yea/blob/main/';

  assert.equal(
    syncedReadme(repoWith(readme, '')),
    [
      `[spec](${blob}SPEC.md "the spec") <a href='${blob}docs/why.md'>why</a> <a href=${blob}LICENSE>l</a>`,
      '',
      `> [s]: ${blob}docs/a.md`,
      '[t]:',
      `  ${blob}docs/b.md "B"`,
      `[u]: <${blob}docs/c.md>`,
      '',
      '[Note]: this is prose, not a definition',
    ].join('\n'),
  );
});

test('code, fenced or indented, is copied as it is; the text around it is not', () => {
  const code = [
    '```ts',
    'interface Args {',
    '  [key: string]: unknown;',
    '}',
    'const tools = {',
    '  [refund.name]: refund,',
    '};',
    'await handlers[name](args);',
    '```',
    '',
    '    <a href="/pricing">pricing</a>',
    '    [k]: v',
    '',
  ];
  const text = (blob) => [
    '- a step',
    '',
    `    [the spec](${blob}SPEC.md), indented as the step's text`,
    '',
    `[spec](${blob}SPEC.md)`,
  ];
  const blob = 'https://github.com/yea-protocol/yea/blob/main/';
  const readme = [...code, ...text('')].join('\n');

  assert.equal(
    syncedReadme(repoWith(readme, '')),
    [...code, ...text(blob)].join('\n'),
  );
  assert.equal(
    syncedReadme(repoWith(readme.replaceAll('\n', '\r\n'), '')),
    [...code, ...text(blob)].join('\r\n'),
  );
});

test('a hand-edited npm README is drift', () => {
  assert.equal(readmeInSync(repoWith('# yea\n', '# yea\n')), true);
  assert.equal(readmeInSync(repoWith('# yea\n', '# yea, edited\n')), false);
});
