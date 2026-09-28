/** The result helpers `@yea-protocol/mcp` exports, for a server's own read tools. */
import { expect, it } from 'vitest';
import { errorResult, textResult } from '../src/index.js';

it('textResult joins lines into one text block, with optional data', () => {
  expect(textResult(['a', 'b'])).toEqual({
    content: [{ type: 'text', text: 'a\nb' }],
  });
  expect(textResult(['a'], { n: 1 })).toEqual({
    content: [{ type: 'text', text: 'a' }],
    structuredContent: { n: 1 },
  });
});

it('errorResult is the same text, marked isError', () => {
  expect(errorResult(['✗ no'], { why: 'x' })).toEqual({
    content: [{ type: 'text', text: '✗ no' }],
    structuredContent: { why: 'x' },
    isError: true,
  });
});
