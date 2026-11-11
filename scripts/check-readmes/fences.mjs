/**
 * The fenced blocks of a Markdown page, read the way CommonMark reads them, so the README checks
 * see every block however its fence is spelled: in backticks or tildes, indented under a list
 * item or quoted with `>`, with its language in any case or none.
 */

/** A fence's opening line: what comes before it (indent, `>`), the fence, and its info string. */
const OPEN = /^([ \t>]*)(`{3,}|~{3,})(.*)$/;

/** A fence's closing line: the fence alone, after the same kind of prefix. */
const CLOSE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;

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
 * Each fenced block in `md`: the line its fence opens on (from 0), its language (lower-cased,
 * '' for none), whether it's in a blockquote, and its code without the fence's prefix. A fence
 * never closed runs to the end, as CommonMark has it.
 */
export function fences(md) {
  const lines = md.split('\n');
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
