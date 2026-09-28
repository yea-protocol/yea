/**
 * The code-organization check (CONTRIBUTING.md#code-organization): every
 * source file opens with a header, stays at or under 300 lines, and has a
 * name in its language's style. Known violations sit in RATCHET until the PR
 * that fixes them; the list may only shrink.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The most lines a source file may have. */
export const MAX_LINES = 300;

/** Source folders, relative to the repo root. A `*` segment matches any folder. */
export const ROOTS = [
  'ts/src',
  'mcp/src',
  'connectors/*/src',
  'cli/bin',
  'scripts',
  'site/scripts',
  'site/.vitepress',
  'python/src',
  'python/mcp/src',
  'deploy/demo/src',
];

/**
 * Today's violations, by file: each rule listed here is known and tolerated
 * until the PR that fixes it. Remove an entry in the PR that fixes it; the
 * check fails if a listed violation no longer occurs.
 */
export const RATCHET = {
  'connectors/stripe/src/api.ts': ['length'], // #108: split
  'connectors/stripe/src/change.ts': ['length'], // #108: split
  'connectors/stripe/src/refund.ts': ['length'], // #108: split
  'mcp/src/bridge/job.ts': ['length'], // #108: split
  'mcp/src/bridge/tools.ts': ['length'], // #108: split
  'python/mcp/src/yea_mcp/call.py': ['length'], // #108: split
  'python/src/yea/approval.py': ['length'], // #108: split
  'python/src/yea/client.py': ['length'], // #108: split
  'python/src/yea/grants.py': ['length'], // #108: split
  'python/src/yea/service.py': ['length'], // #108: split
  'python/src/yea/store.py': ['length'], // #108: split
  'site/.vitepress/theme/components/Landing.vue': ['length'], // #108: split
  'site/.vitepress/theme/components/Playground.vue': ['length'], // #108: split
  'ts/src/approval.ts': ['length'], // #108: split
  'ts/src/ask.ts': ['length'], // #108: split
  'ts/src/client.ts': ['length'], // #108: split
  'ts/src/examples/billing.ts': ['length'], // #108: split
  'ts/src/examples/calendar.ts': ['length'], // #108: split
  'ts/src/examples/demo.ts': ['length'], // #108: split
  'ts/src/filestore.ts': ['length'], // #108: split
  'ts/src/grants.ts': ['length'], // #108: split
  'ts/src/lens.ts': ['length'], // #108: split
  'ts/src/openapi.ts': ['length'], // #108: split
  'ts/src/servefetch.ts': ['length'], // #108: split
  'ts/src/service.ts': ['length'], // #108: split
  'ts/src/setup.ts': ['length'], // #108: split
  'ts/src/tools.ts': ['length'], // #108: split
};

/** Folders never walked: dependencies, build output, caches, tests. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'cache',
  'generated',
  'test',
  'tests',
  '__pycache__',
  '.venv',
]);

const TEST_FILE = /(\.(test|spec)\.[a-z]+|^test_.*\.py|^conftest\.py)$/;
const SCRIPT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*(\.d)?\.(ts|mts|cts|js|mjs|cjs)$/;
const DOCSTRING = /^[rRuU]?("""|''')/;
const PY_PREAMBLE = /^(#!.*|#.*coding[:=].*|\s*)$/;

/** A file's language, by extension: its name rule and its header test. */
const KINDS = [
  {
    ext: /\.(ts|mts|cts|js|mjs|cjs)$/,
    name: SCRIPT_NAME,
    style: 'lowercase words joined with -',
    header: scriptHeader,
    missing: 'no /** */ header before the code',
  },
  {
    ext: /\.vue$/,
    name: /^[A-Z][A-Za-z0-9]*\.vue$/,
    style: 'PascalCase',
    header: vueHeader,
    missing: 'no header comment at the top or in <script setup>',
  },
  {
    ext: /\.py$/,
    name: /^[a-z0-9_]+\.py$/,
    style: 'snake_case',
    header: pythonHeader,
    missing: 'no module docstring',
  },
];

/** True when TS/JS source opens (after any shebang) with a block comment. */
export function scriptHeader(text) {
  return text
    .replace(/^#!.*\n/, '')
    .trimStart()
    .startsWith('/*');
}

/** True when a Vue file opens with a comment, or its first script does. */
export function vueHeader(text) {
  const top = text.trimStart();

  if (top.startsWith('<!--')) {
    return true;
  }

  const script = /<script\b[^>]*>/i.exec(top);

  return (
    script !== null && scriptHeader(top.slice(script.index + script[0].length))
  );
}

/** True when a module's first statement is its docstring. */
export function pythonHeader(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => !PY_PREAMBLE.test(line));

  return start >= 0 && DOCSTRING.test(lines[start].trimStart());
}

/** The number of lines, not counting the final newline. */
export function lineCount(text) {
  if (text === '') {
    return 0;
  }

  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
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

  if (!kind.header(text)) {
    found.push({ path, rule: 'header', detail: kind.missing });
  }

  if (lines > MAX_LINES) {
    found.push({ path, rule: 'length', detail: `${lines} > ${MAX_LINES}` });
  }

  if (!kind.name.test(name)) {
    found.push({ path, rule: 'name', detail: kind.style });
  }

  return found;
}

/** The source files under `dir` (relative to `root`), recursively. */
function walk(root, dir) {
  const files = [];

  for (const entry of readdirSync(`${root}/${dir}`, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;

    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      files.push(...walk(root, path));
    } else if (entry.isFile() && !TEST_FILE.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

/** `roots` with each `*` segment replaced by the folders that exist there. */
function expand(root, roots) {
  return roots.flatMap((pattern) => {
    const star = pattern.indexOf('*');

    if (star < 0) {
      return existsSync(`${root}/${pattern}`) ? [pattern] : [];
    }

    const parent = pattern.slice(0, star - 1);
    const rest = pattern.slice(star + 1);

    if (!existsSync(`${root}/${parent}`)) {
      return [];
    }

    const dirs = readdirSync(`${root}/${parent}`, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `${parent}/${d.name}${rest}`);

    return expand(root, dirs);
  });
}

/** Every violation under `roots`, with paths relative to `root`. */
export function findViolations(root, roots = ROOTS) {
  return expand(root, roots)
    .flatMap((dir) => walk(root, dir))
    .flatMap((path) =>
      checkFile(path, readFileSync(`${root}/${path}`, 'utf8')),
    );
}

/**
 * Violations against the ratchet: `unlisted` ones fail the check, and so do
 * `fixed` ratchet entries that no longer occur.
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
