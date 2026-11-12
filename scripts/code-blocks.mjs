/**
 * The code blocks of a Markdown page, read the way CommonMark reads them. Fenced blocks (in
 * backticks or tildes, indented under a list item or quoted with `>`, with their language in any
 * case or none) are what the README checks pin as snippets. Indented blocks, four spaces in from
 * the text they sit in, are code too, so links are read only from the lines outside both.
 */

/** A fence's opening line: what comes before it (indent, `>`), the fence, and its info string. */
const OPEN = /^([ \t>]*)(`{3,}|~{3,})(.*)$/;

/** A fence's closing line: the fence alone, after the same kind of prefix. */
const CLOSE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;

/** A line's blockquote markers, each `>` with the space after it. */
const QUOTES = /^( {0,3}> ?)+/;

/** A list item's start: its marker, then the spaces before its text, or the end of the line. */
const ITEM = /^([-+*]|\d{1,9}[.)])([ \t]+|$)/;

/** An ATX heading: an indented block may start right after one, as after a blank line. */
const HEADING = /^ {0,3}#{1,6}(\s|$)/;

/** `md`'s lines, whichever line ending it uses. */
export function linesOf(md) {
  return md.split(/\r?\n/);
}

/** True when `line` closes a block opened with `fence`: the same mark, at least as many. */
function closes(line, fence) {
  const m = CLOSE.exec(line);

  return m !== null && m[1][0] === fence[0] && m[1].length >= fence.length;
}

/** `line` without the `prefix` its block's fence opened after, when it has it. */
function unprefixed(line, prefix) {
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

/** True when `info` may follow `fence`: after backticks it can't hold one (that's inline code). */
function opens(fence, info) {
  return fence !== undefined && !(fence[0] === '`' && info.includes('`'));
}

/** The block whose fence opens on line `at` of `lines`, and the line it closes on. */
function blockAt(lines, at) {
  const [, prefix, fence, info] = OPEN.exec(lines[at]) ?? [];

  if (!opens(fence, info)) {
    return undefined;
  }

  const found = lines.findIndex((l, i) => i > at && closes(l, fence));
  const close = found < 0 ? lines.length : found;

  return {
    close,
    block: {
      line: at,
      end: Math.min(close, lines.length - 1),
      lang: info.trim().split(/\s/)[0].toLowerCase(),
      quoted: prefix.includes('>'),
      code: lines
        .slice(at + 1, close)
        .map((l) => unprefixed(l, prefix))
        .join('\n'),
    },
  };
}

/**
 * Each fenced block in `md`: the line its fence opens on (from 0), the line it ends on (its
 * closing fence, or the last line, since a fence never closed runs to the end, as CommonMark has
 * it), its language (lower-cased, '' for none), whether it's in a blockquote, and its code
 * without the fence's prefix.
 */
export function fences(md) {
  const lines = linesOf(md);
  const blocks = [];
  let at = 0;

  while (at < lines.length) {
    const found = blockAt(lines, at);

    if (found) {
      blocks.push(found.block);
    }

    at = (found?.close ?? at) + 1;
  }

  return blocks;
}

/** The width of `text`'s indent, a tab reaching the next multiple of 4. */
function indentOf(text) {
  const lead = /^[ \t]*/.exec(text)?.[0] ?? '';

  return [...lead].reduce(
    (col, ch) => (ch === '\t' ? col + 4 - (col % 4) : col + 1),
    0,
  );
}

/** How far a list item's text starts from its marker's: past the marker and 1 to 4 spaces. */
function itemWidth([, marker, spaces]) {
  const width = indentOf(spaces);
  const gap = width > 0 && width <= 4 ? width : 1;

  return marker.length + gap;
}

/**
 * The scan after `text`, a line outside fences without its `>` markers, given the scan before
 * it: `items`, the indents the open list items' text starts at; `after`, what `text` lets the
 * next line be ('text', a paragraph, which an indented block can't interrupt; 'blank' or
 * 'code', which it can); and `code`, whether `text` is a line of an indented block.
 */
function step({ items, after }, text) {
  if (text.trim() === '') {
    return { items, after: 'blank', code: false };
  }

  const indent = indentOf(text);
  const item = ITEM.exec(text.trimStart());
  const open = items.filter((at) => at <= indent);
  const indented = indent >= (open.at(-1) ?? 0) + 4;
  const heading = HEADING.test(text);
  const interrupts = heading || (item !== null && !indented);

  if (after === 'text' && !interrupts) {
    return { items, after: 'text', code: false };
  }

  if (indented) {
    return { items: open, after: 'code', code: true };
  }

  return {
    items: item === null ? open : [...open, indent + itemWidth(item)],
    after: heading ? 'blank' : 'text',
    code: false,
  };
}

/** The numbers from `first` to `last`, both included. */
function range(first, last) {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/**
 * The lines of `md` (from 0) in a code block: a fenced one, its fences included, or an indented
 * one, four spaces in from the list item it's in (or the margin), which can't interrupt a
 * paragraph.
 */
export function codeLines(md) {
  const blocks = fences(md);
  const opening = new Set(blocks.map(({ line }) => line));
  const fenced = new Set(blocks.flatMap(({ line, end }) => range(line, end)));
  const code = new Set(fenced);
  let scan = { items: [], after: 'blank' };

  for (const [at, line] of linesOf(md).entries()) {
    const text = line.replace(QUOTES, '');

    if (opening.has(at)) {
      const indent = indentOf(text);

      scan = { items: scan.items.filter((i) => i <= indent), after: 'code' };
    } else if (!fenced.has(at)) {
      scan = step(scan, text);

      if (scan.code) {
        code.add(at);
      }
    }
  }

  return code;
}

/**
 * `md` cut into runs of lines, each `{ code, text }`: in code blocks or not. Joined with
 * newlines, the runs' texts are `md` again, line endings and all.
 */
export function runs(md) {
  const code = codeLines(md);
  const cut = [];

  for (const [at, line] of md.split('\n').entries()) {
    const last = cut.at(-1);

    if (last?.code === code.has(at)) {
      last.lines.push(line);
    } else {
      cut.push({ code: code.has(at), lines: [line] });
    }
  }

  return cut.map(({ code, lines }) => ({ code, text: lines.join('\n') }));
}
