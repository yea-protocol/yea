/**
 * A README's pinned snippets. GitHub, npm and PyPI can't include files, so a README copies
 * code; a `<!-- snippet: path#region -->` line marks the fenced block after it as a copy of
 * that region, extracted the way VitePress's `<<<` does, and the copy must match. Any other
 * block must be shell, config, output or a diagram.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fences } from './fences.mjs';

const MARKER = /^<!-- snippet: (\S+)#([\w-]+) -->$/;

/** Region markers by comment style: `# region x` in Python and shell, `// #region x` elsewhere. */
const HASH_REGION = /^# ?(region|endregion) ([\w-]+)$/;
const SLASH_REGION = /^\/\/ ?#?(region|endregion) ([\w-]+)$/;

/**
 * The languages a block needn't come from a tested file in: install lines, config, output and
 * diagrams. Any other language, or none, is code, so a new one fails until it's added here.
 */
const NOT_CODE = new Set([
  'sh',
  'bash',
  'shell',
  'console',
  'json',
  'jsonc',
  'toml',
  'yaml',
  'text',
  'mermaid',
]);

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
 * (VitePress's rules), or undefined when the file has no such region.
 */
export function region(root, file, name) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  const marker = regionMarker(file);
  const start = lines.findIndex((l) => marks(l, marker, ['region', name]));
  const end = lines.findIndex(
    (l, i) => i > start && marks(l, marker, ['endregion', name]),
  );

  if (start < 0 || end < 0) {
    return undefined;
  }

  return dedent(
    lines.slice(start + 1, end).filter((l) => !marker.test(l.trim())),
  );
}

/**
 * Each snippet marker in `md`: its line (from 1), the file and region it names, and the code of
 * the block right after it (undefined when there's none).
 */
export function snippets(md) {
  const blocks = fences(md);

  return md.split('\n').flatMap((line, i) => {
    const m = MARKER.exec(line.trim());

    if (m === null) {
      return [];
    }

    const code = blocks.find((b) => b.line === i + 1)?.code;

    return [{ line: i + 1, file: m[1], name: m[2], code }];
  });
}

/** The opening line of each code block in `md` that no snippet marker pins. */
function unpinnedCode(md) {
  const lines = md.split('\n');

  return fences(md)
    .filter(({ lang }) => !NOT_CODE.has(lang))
    .filter(({ line }) => !MARKER.test(lines[line - 1]?.trim() ?? ''))
    .map(({ line }) => `line ${line + 1}`);
}

/** A line, if one is due, saying why a snippet in the README `readme` doesn't match its region. */
function snippetProblem(root, readme, { line, file, name, code }) {
  const marker = `${readme}: the marker at line ${line}`;

  if (code === undefined) {
    return [`${marker} isn't followed by a code block`];
  }

  if (!existsSync(join(root, file))) {
    return [`${marker} names ${file}#${name}, but there is no ${file}`];
  }

  const text = region(root, file, name);

  if (text === undefined) {
    return [
      `${marker} names ${file}#${name}, but ${file} has no region ${name}`,
    ];
  }

  return text === code
    ? []
    : [
        `${readme}: the snippet from ${file}#${name} differs from the file. Copy the region again.`,
      ];
}

/**
 * A line for each way the README `readme`, whose text is `md`, breaks the snippet rules under
 * `root`: a marker that names nothing or pins no block, a snippet that differs from its region,
 * a code block no marker pins, or no snippet.
 */
export function snippetProblems(root, readme, md) {
  const found = snippets(md);
  const broken = found.flatMap((s) => snippetProblem(root, readme, s));
  const unpinned = unpinnedCode(md).map(
    (at) =>
      `${readme}: the code block at ${at} has no snippet marker; copy it from a tested file`,
  );
  const none =
    found.length === 0
      ? [`${readme}: no snippet markers found; pin one from a tested file`]
      : [];

  return [...broken, ...unpinned, ...none];
}
