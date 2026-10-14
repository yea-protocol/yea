/**
 * Tests for check-pr-body.mjs: the issue link, each section, Merge danger's
 * door and blast radius, and the PR template itself, untouched and filled in.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkPrBody } from './check-pr-body.mjs';

const TEMPLATE = readFileSync(
  new URL('../.github/pull_request_template.md', import.meta.url),
  'utf8',
);

/** A body's sections, filled in; a test prepends the link. */
const FILLED = `## Summary
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

/** `FILLED` without the section under `heading`. */
function without(heading) {
  return FILLED.split(/(?=^## )/m)
    .filter((s) => !s.startsWith(`## ${heading}`))
    .join('');
}

test('a body with a link and every section filled in passes', () => {
  assert.deepEqual(rules(`Closes #12\n\n${FILLED}`), []);
});

test('link: Closes, Fixes, Resolves or Part of an issue, at a line start', () => {
  for (const link of [
    'Closes #1',
    'fixes #2.',
    'Resolves #3',
    'Part of #4 (the P2).',
  ]) {
    assert.deepEqual(rules(`${link}\n\n${FILLED}`), [], link);
  }

  for (const link of ['Closes #', 'See #4', 'This closes #5', '']) {
    assert.deepEqual(rules(`${link}\n\n${FILLED}`), ['link'], link);
  }
});

test('link: one inside an HTML comment does not count', () => {
  assert.deepEqual(rules(`<!--\nCloses #9\n-->\n\n${FILLED}`), ['link']);
});

test('sections: each heading is there, with something under it', () => {
  assert.deepEqual(rules(`Closes #1\n\n${without('Summary')}`), ['summary']);
  assert.deepEqual(rules(`Closes #1\n\n${without('Evidence')}`), ['evidence']);
  assert.deepEqual(rules(`Closes #1\n\n${without('Merge danger')}`), [
    'merge-danger',
  ]);

  const empty = FILLED.replace(
    'The check runs on every PR.',
    '<!-- A sketch. -->',
  );

  assert.deepEqual(rules(`Closes #1\n\n${empty}`), ['summary']);
});

test('sections: headings match whatever their case or level-2 spacing', () => {
  const lower = FILLED.replace('## Summary', '##   summary');

  assert.deepEqual(rules(`Closes #1\n\n${lower}`), []);
});

test('sections: a body saved from the web UI, with CRLF endings, passes', () => {
  const crlf = `Closes #1\n\n${FILLED}`.replaceAll('\n', '\r\n');

  assert.deepEqual(rules(crlf), []);
});

test('door: one-way or two-way, nothing else', () => {
  for (const door of ['one-way', 'Two-way', 'one-way: the labels rename']) {
    const body = FILLED.replace('two-way', door);

    assert.deepEqual(rules(`Closes #1\n\n${body}`), [], door);
  }

  for (const door of ['', 'maybe', '<!-- one-way or two-way -->']) {
    const body = FILLED.replace('two-way', door);

    assert.deepEqual(rules(`Closes #1\n\n${body}`), ['door'], door);
  }
});

test('door: only counts under Merge danger', () => {
  const elsewhere = FILLED.replace('**Door:** two-way\n', '').replace(
    '## Summary\n',
    '## Summary\n**Door:** two-way\n',
  );

  assert.deepEqual(rules(`Closes #1\n\n${elsewhere}`), ['door']);
});

test('blast radius: something after the label, under Merge danger', () => {
  for (const radius of ['', '<!-- who breaks -->']) {
    const body = FILLED.replace(
      '**Blast radius:** CI',
      `**Blast radius:** ${radius}`,
    );

    assert.deepEqual(rules(`Closes #1\n\n${body}`), ['blast-radius'], radius);
  }

  const elsewhere = without('Merge danger').replace(
    '## Evidence\n',
    '## Evidence\n**Blast radius:** CI\n',
  );

  assert.deepEqual(
    rules(`Closes #1\n\n${elsewhere}## Merge danger\n**Door:** two-way\n`),
    ['blast-radius'],
  );
});

test('an empty or missing body breaks every rule a body can', () => {
  const all = ['link', 'summary', 'evidence', 'merge-danger'];

  assert.deepEqual(rules(''), all);
  assert.deepEqual(rules(undefined), all);
});

test('the untouched template fails, so a PR has to fill it in', () => {
  assert.deepEqual(rules(TEMPLATE), [
    'link',
    'summary',
    'evidence',
    'door',
    'blast-radius',
  ]);
});

test('the template, filled in, passes', () => {
  const filled = TEMPLATE.replace('Closes #', 'Closes #266')
    .replace('## Summary', '## Summary\nA sketch.')
    .replace('## Evidence', '## Evidence\nA test run.')
    .replace('**Door:**', '**Door:** two-way')
    .replace('**Blast radius:**', '**Blast radius:** CI');

  assert.deepEqual(rules(filled), []);
});

test('every problem says how to fix it', () => {
  const body = `Closes #1\n\n${without('Merge danger')}## Merge danger\n`;

  for (const problem of [...checkPrBody(''), ...checkPrBody(body)]) {
    assert.match(problem.message, /\S/, problem.rule);
  }
});
