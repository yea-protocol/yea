/**
 * Tests for check-pr-body.mjs: the issue link, each section, the door, and the
 * PR template itself, untouched and filled in.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkPrBody } from './check-pr-body.mjs';

const TEMPLATE = readFileSync(
  new URL('../.github/pull_request_template.md', import.meta.url),
  'utf8',
);

const SECTIONS = `## Summary
The check runs on every PR.

## Evidence
- **Before:** no check. **After:** the check fails on an empty body.

## Merge danger
**Door:** two-way

**Blast radius:** CI
`;

/** The rules `body` breaks. */
function rules(body) {
  return checkPrBody(body).map((p) => p.rule);
}

test('a body with a link, every section and a door passes', () => {
  assert.deepEqual(rules(`Closes #12\n\n${SECTIONS}`), []);
});

test('link: Closes, Fixes, Resolves or Part of an issue, at a line start', () => {
  for (const link of [
    'Closes #1',
    'fixes #2.',
    'Resolves #3',
    'Part of #4 (the P2).',
  ]) {
    assert.deepEqual(rules(`${link}\n\n${SECTIONS}`), [], link);
  }

  for (const link of ['Closes #', 'See #4', 'This closes #5', '']) {
    assert.deepEqual(rules(`${link}\n\n${SECTIONS}`), ['link'], link);
  }
});

test('link: one inside an HTML comment does not count', () => {
  assert.deepEqual(rules(`<!--\nCloses #9\n-->\n\n${SECTIONS}`), ['link']);
});

test('sections: each heading is there, with something under it', () => {
  const without = (heading) =>
    SECTIONS.split(/(?=^## )/m)
      .filter((s) => !s.startsWith(`## ${heading}`))
      .join('');

  assert.deepEqual(rules(`Closes #1\n\n${without('Summary')}`), ['summary']);
  assert.deepEqual(rules(`Closes #1\n\n${without('Evidence')}`), ['evidence']);
  assert.deepEqual(rules(`Closes #1\n\n${without('Merge danger')}`), [
    'merge-danger',
    'door',
  ]);

  const empty = SECTIONS.replace(
    'The check runs on every PR.',
    '<!-- A sketch. -->',
  );

  assert.deepEqual(rules(`Closes #1\n\n${empty}`), ['summary']);
});

test('sections: headings match whatever their case or level-2 spacing', () => {
  const lower = SECTIONS.replace('## Summary', '##   summary');

  assert.deepEqual(rules(`Closes #1\n\n${lower}`), []);
});

test('sections: a body saved from the web UI, with CRLF endings, passes', () => {
  const crlf = `Closes #1\n\n${SECTIONS}`.replaceAll('\n', '\r\n');

  assert.deepEqual(rules(crlf), []);
});

test('door: one-way or two-way, nothing else', () => {
  for (const door of ['one-way', 'Two-way', 'one-way: the labels rename']) {
    const body = SECTIONS.replace('two-way', door);

    assert.deepEqual(rules(`Closes #1\n\n${body}`), [], door);
  }

  for (const door of ['', 'maybe', '<!-- one-way or two-way -->']) {
    const body = SECTIONS.replace('two-way', door);

    assert.deepEqual(rules(`Closes #1\n\n${body}`), ['door'], door);
  }
});

test('an empty or missing body breaks every rule', () => {
  const all = ['link', 'summary', 'evidence', 'merge-danger', 'door'];

  assert.deepEqual(rules(''), all);
  assert.deepEqual(rules(undefined), all);
});

test('the untouched template fails, so a PR has to fill it in', () => {
  assert.deepEqual(rules(TEMPLATE), ['link', 'summary', 'evidence', 'door']);
});

test('the template, filled in, passes', () => {
  const filled = TEMPLATE.replace('Closes #', 'Closes #266')
    .replace('## Summary', '## Summary\nA sketch.')
    .replace('## Evidence', '## Evidence\nA test run.')
    .replace('**Door:**', '**Door:** two-way');

  assert.deepEqual(rules(filled), []);
});

test('every problem says how to fix it', () => {
  for (const problem of checkPrBody('')) {
    assert.match(problem.message, /\S/, problem.rule);
  }
});
