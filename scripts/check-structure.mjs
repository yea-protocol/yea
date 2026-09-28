/**
 * The code-organization check (CONTRIBUTING.md#code-organization): every
 * source file opens with a file header, stays at or under 300 lines, and has
 * a name in its language's style. Known violations sit in RATCHET until the
 * PR that fixes them; the list may only shrink.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The most lines a source file may have. */
export const MAX_LINES = 300;

/** Source folders, relative to the repo root. One whole middle segment may be `*`. */
export const ROOTS = [
  'ts/src',
  'ts/scripts',
  'mcp/src',
  'connectors/*/src',
  'cli/bin',
  'scripts',
  'site/scripts',
  'site/.vitepress',
  'python/src',
  'python/mcp/src',
  'deploy/demo/src',
  'bench',
];

/** Exempt from the length rule: benchmarks, and the conformance vector generators (mostly data). */
export const LENGTH_EXEMPT = [
  'bench/',
  'ts/scripts/vectors.mjs',
  'ts/scripts/approval-vectors.mjs',
];

/**
 * Today's violations, by file: each rule listed here is known and tolerated
 * until the PR that fixes it, which also removes the entry. The check fails
 * when a listed violation no longer occurs.
 */
export const RATCHET = {
  'mcp/src/bridge/job.ts': ['length'], // #108: split
  'mcp/src/bridge/tools.ts': ['length'], // #108: split
  'mcp/src/serverkey.ts': ['name'], // #108: rename to server-key.ts
  'python/mcp/src/yea_mcp/call.py': ['length'], // #108: split
  'python/src/yea/approval.py': ['length'], // #108: split
  'python/src/yea/client.py': ['length'], // #108: split
  'python/src/yea/grants.py': ['length'], // #108: split
  'python/src/yea/lens.py': ['length'], // #108: split
  'python/src/yea/service.py': ['length'], // #108: split
  'python/src/yea/store.py': ['length'], // #108: split
  'site/.vitepress/theme/components/Landing.vue': ['length'], // #108: split
  'ts/src/ask.ts': ['length'], // #108: split
  'ts/src/examples/billing.ts': ['length'], // #108: split
  'ts/src/examples/calendar.ts': ['length'], // #108: split
  'ts/src/examples/demo.ts': ['length'], // #108: split
  'ts/src/filestore.ts': ['length', 'name'], // #108: file-store/ split
  'ts/src/keyfile.ts': ['name'], // #108: rename to key-file.ts
  'ts/src/lens.ts': ['length'], // #108: split
  'ts/src/openapi.ts': ['length'], // #108: split
  'ts/src/servefetch.ts': ['length', 'name'], // #108: serve-fetch/ split
  'ts/src/setup.ts': ['length'], // #108: split
  'ts/src/testdrive.ts': ['name'], // #108: rename to test-drive.ts
  'ts/src/tooldefs.ts': ['name'], // #108: rename to tool-defs.ts
  'ts/src/tools.ts': ['length'], // #108: split
};

/** Names whose words run together (see the ratchet for the names they get). */
const JOINED = /^(servefetch|filestore|keyfile|serverkey|tooldefs|testdrive)\./;

/** Never walked: VitePress output and caches, and build or dependency folders anywhere. */
const SKIP_PATHS = new Set(
  ['cache', 'dist', '.temp', 'generated'].map((d) => `site/.vitepress/${d}`),
);
const SKIP_NAMES = new Set(['node_modules', 'dist', '__pycache__', '.venv']);

const TEST_FILE = /(\.(test|spec)\.[a-z]+|^test_.*\.py|^conftest\.py)$/;
const DECLARATION =
  /^(export|function|async|const|let|var|class|interface|type|enum|abstract|declare)\b/;
const DOCSTRING = /^[rRuU]?("""|''')/;
const PY_PREAMBLE = /^(#.*|\s*)$/;
const HEADER =
  'no /** */ file header; one directly above a declaration is its JSDoc';

/** A file's language, by extension: its name rule and its header test. */
const KINDS = [
  {
    ext: /\.(ts|mts|cts|js|mjs|cjs)$/,
    name: /^[a-z0-9]+(-[a-z0-9]+)*(\.d)?\.(ts|mts|cts|js|mjs|cjs)$/,
    style: 'lowercase words joined with -',
    header: scriptHeader,
    missing: HEADER,
  },
  {
    ext: /\.vue$/,
    name: /^[A-Z][A-Za-z0-9]*\.vue$/,
    style: 'PascalCase',
    header: vueHeader,
    missing: `${HEADER} at the top of <script>`,
  },
  {
    ext: /\.py$/,
    name: /^[a-z0-9_]+\.py$/,
    style: 'snake_case',
    header: pythonHeader,
    missing: 'no module docstring',
  },
];

/**
 * True when TS/JS source opens (after any shebang) with a `/**` comment that
 * isn't directly above a declaration.
 */
export function scriptHeader(text) {
  const body = text.replace(/^#!.*\n/, '').trimStart();
  const end = body.indexOf('*/');

  if (!body.startsWith('/**') || end < 0) {
    return false;
  }

  const [rest, next = ''] = body.slice(end + 2).split('\n');
  const following = rest.trim() === '' ? next : rest.trim();

  return !DECLARATION.test(following);
}

/** True when a Vue file's first `<script>` opens with a file header. */
export function vueHeader(text) {
  const script = /<script\b[^>]*>/i.exec(text);

  return (
    script !== null && scriptHeader(text.slice(script.index + script[0].length))
  );
}

/** True when a module's first statement is its docstring. */
export function pythonHeader(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => !PY_PREAMBLE.test(line));

  return start >= 0 && DOCSTRING.test(lines[start]);
}

/** The number of lines, not counting the final newline. */
export function lineCount(text) {
  return text === ''
    ? 0
    : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Why `name` breaks the naming rule for `kind`, or undefined when it doesn't. */
function badName(kind, name) {
  if (!kind.name.test(name)) {
    return kind.style;
  }

  return JOINED.test(name) ? 'words run together; join them with -' : undefined;
}

/** One file's violations as `{ path, rule, detail }`. */
export function checkFile(path, text) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const kind = KINDS.find((k) => k.ext.test(name));

  if (kind === undefined) {
    return [];
  }

  const found = [];
  const lines = lineCount(text);
  const exempt = LENGTH_EXEMPT.some((p) => path.startsWith(p));
  const naming = badName(kind, name);

  if (!kind.header(text)) {
    found.push({ path, rule: 'header', detail: kind.missing });
  }

  if (lines > MAX_LINES && !exempt) {
    found.push({ path, rule: 'length', detail: `${lines} > ${MAX_LINES}` });
  }

  if (naming !== undefined) {
    found.push({ path, rule: 'name', detail: naming });
  }

  return found;
}

/** The source files under `dir` (relative to `root`), recursively. */
function walk(root, dir) {
  const files = [];

  for (const entry of readdirSync(`${root}/${dir}`, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    const skip = SKIP_PATHS.has(path) || SKIP_NAMES.has(entry.name);

    if (entry.isDirectory() && !skip) {
      files.push(...walk(root, path));
    } else if (entry.isFile() && !TEST_FILE.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

/** The folders `pattern` names: itself, or one per match of its `*` segment. */
export function expand(root, pattern) {
  const parts = pattern.split('/');
  const star = parts.indexOf('*');
  const stray = parts.some((p, i) => p.includes('*') && i !== star);

  if (stray || star === 0 || star === parts.length - 1) {
    throw new Error(
      `unsupported root ${pattern}: only one middle segment may be *`,
    );
  }

  if (star < 0) {
    return existsSync(`${root}/${pattern}`) ? [pattern] : [];
  }

  const parent = parts.slice(0, star).join('/');
  const rest = parts.slice(star + 1).join('/');
  const dirs = existsSync(`${root}/${parent}`)
    ? readdirSync(`${root}/${parent}`, { withFileTypes: true })
    : [];

  return dirs
    .filter((d) => d.isDirectory())
    .map((d) => `${parent}/${d.name}/${rest}`)
    .filter((dir) => existsSync(`${root}/${dir}`));
}

/** Every violation under `roots`, sorted, with paths relative to `root`. */
export function findViolations(root, roots = ROOTS) {
  return roots
    .flatMap((pattern) => expand(root, pattern))
    .flatMap((dir) => walk(root, dir))
    .flatMap((path) => checkFile(path, readFileSync(`${root}/${path}`, 'utf8')))
    .sort((a, b) => `${a.path} ${a.rule}`.localeCompare(`${b.path} ${b.rule}`));
}

/**
 * Violations against the ratchet: `unlisted` ones fail the check, and so do
 * `fixed` ratchet entries that no longer occur (fixed, renamed or removed).
 */
export function compare(violations, ratchet) {
  const listed = (v) => (ratchet[v.path] ?? []).includes(v.rule);
  const occurs = (path, rule) =>
    violations.some((v) => v.path === path && v.rule === rule);
  const fixed = Object.entries(ratchet).flatMap(([path, rules]) =>
    rules.filter((rule) => !occurs(path, rule)).map((rule) => ({ path, rule })),
  );

  return { unlisted: violations.filter((v) => !listed(v)), fixed };
}

/** The report lines, one per problem: `path: rule (details)`. */
export function report({ unlisted, fixed }) {
  return [
    ...unlisted.map((v) => `${v.path}: ${v.rule} (${v.detail})`),
    ...fixed.map(
      (v) =>
        `${v.path}: ${v.rule} (no longer occurs: remove it from the ratchet)`,
    ),
  ];
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const lines = report(compare(findViolations(root), RATCHET));

  for (const line of lines) {
    console.error(line);
  }

  if (lines.length > 0) {
    console.error('\nSee CONTRIBUTING.md#code-organization.');
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
