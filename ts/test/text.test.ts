import { describe, expect, it } from 'vitest';
import { clip, printable } from '../src/text.js';

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

describe('printable', () => {
  it('escapes controls, format characters and separators as \\u{hex}', () => {
    expect(printable('a\nb\x7fc\x85d')).toBe('a\\u{a}b\\u{7f}c\\u{85}d');
    expect(printable('a\u200bb\u00adc\ufeffd')).toBe(
      'a\\u{200b}b\\u{ad}c\\u{feff}d',
    );
    expect(printable('a\u{e0041}b\u3164c')).toBe('a\\u{e0041}b\\u{3164}c');
    expect(printable('a\u034fb\u17b4c')).toBe('a\\u{34f}b\\u{17b4}c');
  });

  it('keeps tab, accents, CJK and plain emoji', () => {
    // A variation selector picks a glyph's style; the Braille blank shows as a blank cell.
    expect(printable('\u2764\ufe0f \u2800')).toBe('\u2764\ufe0f \u2800');
    expect(printable('\tcafé 東京 😀')).toBe('\tcafé 東京 😀');
  });
});
