/**
 * A README's pinned snippets. GitHub, npm and PyPI can't include files, so a README copies
 * code; a `<!-- snippet: path#region -->` line marks the fenced block after it as a copy of
 * that region, extracted the way VitePress's `<<<` does, and the copy must match.
 */
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const MARKER = /^<!-- snippet: (\S+)#([\w-]+) -->$/;

/** Region markers by comment style: `# region x` in Python and shell, `// #region x` elsewhere. */
const HASH_REGION = /^# ?(region|endregion) ([\w-]+)$/;
const SLASH_REGION = /^\/\/ ?#?(region|endregion) ([\w-]+)$/;

/** The fences whose code must come from a tested file: install and config lines needn't. */
const CODE = /^```(ts|tsx|typescript|js|mjs|javascript|py|python)\b/;

/** The marker pattern for `file`, by its extension. */
function regionMarker(file) {
  return ['.py', '.sh'].includes(extname(file)) ? HASH_REGION : SLASH_REGION;
}

/** True when `line` is `marker`'s `tag` (region or endregion) for `name`. */
function marks(line, marker, [tag, name]) {
  const m = marker.exec(line.trim());

  return m !== null && m[1] === tag && m[2] === name;
}

/** `lines` without their common indent, joined. */
function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => l.search(/\S/));
  const min = Math.min(...indents);

  return lines.map((l) => l.slice(min)).join('\n');
}

/**
 * The lines of region `name` in `file` under `root`, without region markers, dedented
 * (VitePress's rules).
 */
export function region(root, file, name) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  const marker = regionMarker(file);
  const start = lines.findIndex((l) => marks(l, marker, ['region', name]));
  const end = lines.findIndex(
    (l, i) => i > start && marks(l, marker, ['endregion', name]),
  );

  if (start < 0 || end < 0) {
    throw new Error(`${file} has no region ${name}`);
  }

  return dedent(
    lines.slice(start + 1, end).filter((l) => !marker.test(l.trim())),
  );
}

/** The code of the fenced block that opens on line `from` of `lines`. */
function fenced(lines, from) {
  const open = lines.findIndex((l, i) => i >= from && l.startsWith('```'));
  const close = lines.findIndex((l, i) => i > open && l.startsWith('```'));

  if (open !== from || close < 0) {
    throw new Error(
      `line ${from}: a snippet marker must be followed by a code block`,
    );
  }

  return lines.slice(open + 1, close).join('\n');
}

/** Each marked snippet in `md`: where it says it came from, and the fenced code after it. */
export function snippets(md) {
  const lines = md.split('\n');

  return [...lines.entries()].flatMap(([i, line]) => {
    const m = MARKER.exec(line.trim());

    return m ? [{ file: m[1], name: m[2], code: fenced(lines, i + 1) }] : [];
  });
}

/** The opening line of each code block in `md` that no snippet marker pins. */
function unpinnedCode(md) {
  const lines = md.split('\n');
  const opens = lines.flatMap((line, i) => (CODE.test(line) ? [i] : []));

  return opens
    .filter((i) => !MARKER.test(lines[i - 1]?.trim() ?? ''))
    .map((i) => `line ${i + 1}`);
}

/**
 * A line for each way the README `name`, whose text is `md`, breaks the snippet rules under
 * `root`: a snippet that differs from its region, a code block no marker pins, or no snippet.
 */
export function snippetProblems(root, name, md) {
  const found = snippets(md);
  const drifted = found
    .filter((s) => s.code !== region(root, s.file, s.name))
    .map(
      (s) =>
        `${name}: the snippet from ${s.file}#${s.name} differs from the file. Copy the region again.`,
    );
  const unpinned = unpinnedCode(md).map(
    (at) =>
      `${name}: the code block at ${at} has no snippet marker; copy it from a tested file`,
  );
  const none =
    found.length === 0
      ? [`${name}: no snippet markers found; pin one from a tested file`]
      : [];

  return [...drifted, ...unpinned, ...none];
}
