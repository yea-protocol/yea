// Fails when a README snippet drifts from the example it was copied from. GitHub can't
// include files, so the README copies code; a `<!-- snippet: path#region -->` line marks the
// fenced block after it as a copy of that region, extracted the way VitePress's `<<<` does.
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const MARKER = /^<!-- snippet: (\S+)#([\w-]+) -->$/;
const REGION = /^\/\/ ?#?(region|endregion) ([\w-]+)$/;

/** The lines of `region` in `file`, without region markers, dedented (VitePress's rules). */
function region(file, name) {
  const lines = readFileSync(new URL(file, root), 'utf8').split('\n');
  const start = lines.findIndex((l) => marks(l, 'region', name));
  const end = lines.findIndex(
    (l, i) => i > start && marks(l, 'endregion', name),
  );

  if (start < 0 || end < 0) {
    throw new Error(`${file} has no region ${name}`);
  }

  return dedent(
    lines.slice(start + 1, end).filter((l) => !REGION.test(l.trim())),
  );
}

function marks(line, tag, name) {
  const m = REGION.exec(line.trim());

  return m !== null && m[1] === tag && m[2] === name;
}

function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => l.search(/\S/));
  const min = Math.min(...indents);

  return lines.map((l) => l.slice(min)).join('\n');
}

/** Each marked snippet in `md`: where it says it came from, and the fenced code after it. */
function snippets(md) {
  const lines = md.split('\n');
  const found = [];

  for (const [i, line] of lines.entries()) {
    const m = MARKER.exec(line.trim());

    if (m) {
      found.push({ file: m[1], name: m[2], code: fenced(lines, i + 1) });
    }
  }

  return found;
}

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

let failed = 0;
const found = snippets(readFileSync(new URL('README.md', root), 'utf8'));

for (const s of found) {
  if (s.code !== region(s.file, s.name)) {
    failed++;
    console.error(
      `README.md: the snippet from ${s.file}#${s.name} differs from the file. Copy the region again.`,
    );
  }
}

if (found.length === 0) {
  failed++;
  console.error(
    'README.md: no snippet markers found; the drift check has nothing to check',
  );
}

if (failed) {
  process.exit(1);
}

console.log(`README snippets match their examples (${found.length})`);
