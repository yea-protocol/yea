import { describe, expect, it } from 'vitest';
import { clip } from '../src/text.js';

describe('clip', () => {
  it('leaves text of at most max code points alone', () => {
    expect(clip('hello', 5)).toBe('hello');
    expect(clip('abcd😀', 5)).toBe('abcd😀');
    expect(clip('', 3)).toBe('');
  });

  it('cuts BMP text to max, ending in …', () => {
    expect(clip('hello world', 5)).toBe('hell…');
    expect(clip('héllo wörld', 6)).toBe('héllo…');
  });

  it('counts an astral character as one and never splits its surrogate pair', () => {
    expect(clip('abc😀def', 5)).toBe('abc😀…');
    expect(clip('abcd😀e', 5)).toBe('abcd…');
    expect(clip('😀😀😀', 2)).toBe('😀…');

    for (let max = 1; max <= 8; max++) {
      expect(clip('a😀b😀c😀d😀', max)).not.toMatch(/\p{Cs}/u);
    }
  });

  it('gives just … at max 1, and nothing below 1', () => {
    expect(clip('hello', 1)).toBe('…');
    expect(clip('hello', 0)).toBe('');
    expect(clip('hello', -3)).toBe('');
  });
});
