/**
 * Tests for code-blocks.mjs: which lines of a page are code, fenced or indented, as CommonMark
 * reads them (an indented block needs a blank line, a heading or code before it, and starts four
 * spaces in from the list item it's in), and the runs that put a page back together.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeLines, runs } from './code-blocks.mjs';

/** The lines of `lines` (from 1) that are code. */
const code = (lines) =>
  [...codeLines(lines.join('\n'))].sort((a, b) => a - b).map((i) => i + 1);

test('an indented block follows a blank line, a heading or code, never a paragraph', () => {
  assert.deepEqual(code(['text', '', '    a', '', '    b', 'text']), [3, 5]);
  assert.deepEqual(code(['', '    a', '    b']), [2, 3]);
  assert.deepEqual(code(['text', '    a paragraph line']), []);
  assert.deepEqual(code(['text', '    - not an item', '', '    a']), [4]);
  assert.deepEqual(code(['## Example', '    a']), [2]);
  assert.deepEqual(code(['text', '## Example', '    a']), [3]);
  assert.deepEqual(code(['Title', '=====', '    a']), [3]);
  assert.deepEqual(code(['Title', '--', '    a']), [3]);
  assert.deepEqual(code(['* * *', '', '    a']), [3]);
  assert.deepEqual(code(['- - -', '', '    a']), [3]);
  assert.deepEqual(code(['```sh', 'x', '```', '    a']), [1, 2, 3, 4]);
  assert.deepEqual(code(['', '\ta']), [2]);
});

test("in a list item, an indented block starts four spaces in from the item's text", () => {
  assert.deepEqual(code(['- a', '', '    text of a', '', '      code']), [5]);
  assert.deepEqual(
    code(['1. a', '', '   text', '', '       code', '', '    text']),
    [5],
  );
  assert.deepEqual(
    code(['- a', '  - b', '', '      text of b', '', '        code']),
    [6],
  );
  assert.deepEqual(
    code(['-\ta', '', '      text of a', '', '         code']),
    [5],
  );
  assert.deepEqual(code(['-\ta', '', '        code']), [3]);
  assert.deepEqual(code(['- a', '', 'text', '', '    code']), [5]);
  assert.deepEqual(
    code(['- a', '', '  1.    b', '', '      code', '', '        code']),
    [5, 7],
  );
  assert.deepEqual(
    code(['- a', '  - b', '', '  text of a', '', '      code']),
    [6],
  );
  assert.deepEqual(code(['-     a', '', '      code']), [3]);
  assert.deepEqual(
    code(['- a', '```sh', 'x', '```', '', '    code']),
    [2, 3, 4, 6],
  );
});

test('a quoted block is read inside its quote; HTML is not code', () => {
  assert.deepEqual(code(['> quote', '>', '>     code', '> text']), [3]);
  assert.deepEqual(
    code(['<p align="center">', '    <img src="x.svg">', '</p>']),
    [],
  );
});

test('a fence never closed is code to the end', () => {
  assert.deepEqual(code(['text', '```ts', 'a', '', 'b']), [2, 3, 4, 5]);
});

test('runs put the page back together, line endings and all', () => {
  const md = 'text\r\n\r\n```ts\r\na\r\n```\r\nmore\r\n';

  assert.deepEqual(runs(md), [
    { code: false, text: 'text\r\n\r' },
    { code: true, text: '```ts\r\na\r\n```\r' },
    { code: false, text: 'more\r\n' },
  ]);
  assert.equal(
    runs(md)
      .map(({ text }) => text)
      .join('\n'),
    md,
  );
});
