/**
 * The code-organization check (CONTRIBUTING.md#code-organization): every
 * source file opens with a file header, stays at or under 300 lines, and has
 * a name in its language's style, and no file imports from inside another
 * module's folder (ADR-0001). Known violations sit in RATCHET until the PR
 * that fixes them; the list may only shrink.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  pythonHeader,
  scriptHeader,
  vueHeader,
} from './check-structure/headers.mjs';
import { privateFolders } from './check-structure/private-folders.mjs';
import { privatePackages } from './check-structure/private-packages.mjs';

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

/** Python examples, read only for imports into a package's private modules: adopters copy them. */
export const EXAMPLES = ['python/examples', 'python/mcp/examples'];

/** Exempt from the length rule: benchmarks, and the conformance vector generators (mostly data). */
export const LENGTH_EXEMPT = [
  'bench/',
  'ts/scripts/vectors.mjs',
  'ts/scripts/approval-vectors.mjs',
];

/**
 * Today's violations, by file: each entry listed here is known and tolerated
 * until the PR that fixes it, which also removes it. An entry is a rule, or
 * for `private` the rule and the file imported, so a listed file can't add a
 * new private import. The check fails when a listed violation no longer occurs.
 */
export const RATCHET = {
  // Imports from inside another module's folder (ADR-0001): #284.
  'mcp/src/bridge.ts': ['private mcp/src/bridge/tools/generic.ts'],
  'mcp/src/bridge/instructions.ts': ['private mcp/src/bridge/tools/generic.ts'],
  'site/.vitepress/theme/components/landing/HeroSection.vue': [
    'private site/.vitepress/theme/components/playground/SegmentedRadio.vue',
  ],
  // The same in Python, and imports of another package's _ modules: #336.
  'python/mcp/src/yea_mcp/__init__.py': [
    'private python/src/yea/store/files.py',
  ],
  'python/mcp/src/yea_mcp/server_key.py': [
    'private python/src/yea/_json.py',
    'private python/src/yea/store/files.py',
  ],
  'python/src/yea/approval/plan.py': ['private python/src/yea/lens/depth.py'],
  'python/src/yea/approve.py': ['private python/src/yea/lens/depth.py'],
  'python/src/yea/job_call/__init__.py': [
    'private python/src/yea/approval/decision.py',
  ],
  'python/src/yea/job_call/answer.py': [
    'private python/src/yea/approval/decision.py',
  ],
  'python/src/yea/job_call/ask.py': [
    'private python/src/yea/approval/decision.py',
  ],
  'python/src/yea/text.py': ['private python/src/yea/lens/depth.py'],
  'python/src/yea/transport.py': ['private python/src/yea/service/util.py'],
};

/** Run-together names, since renamed to kebab-case (#108); they may not come back. */
const JOINED = /^(servefetch|filestore|keyfile|serverkey|tooldefs|testdrive)\./;

/** Never walked: VitePress output and caches, and build or dependency folders anywhere. */
const SKIP_PATHS = new Set(
  ['cache', 'dist', '.temp', 'generated'].map((d) => `site/.vitepress/${d}`),
);
const SKIP_NAMES = new Set(['node_modules', 'dist', '__pycache__', '.venv']);

const TEST_FILE = /(\.(test|spec)\.[a-z]+|^test_.*\.py|^conftest\.py)$/;
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

/** The source folder `dir` as `{ dir, files }`, its files a Map of path to text. */
function readRoot(root, dir) {
  const read = (path) => [path, readFileSync(`${root}/${path}`, 'utf8')];

  return { dir, files: new Map(walk(root, dir).map(read)) };
}

/** The violations in one source folder: each file's, then its relative imports'. */
function checkRoot({ dir, files }) {
  return [
    ...[...files].flatMap(([path, text]) => checkFile(path, text)),
    ...privateFolders(dir, files),
  ];
}

/** The source folders `patterns` name under `root`, read. */
function readRoots(root, patterns) {
  return patterns
    .flatMap((pattern) => expand(root, pattern))
    .map((dir) => readRoot(root, dir));
}

/**
 * Every violation under `roots`, and in the imports of `examples`, sorted,
 * with paths relative to `root`.
 */
export function findViolations(root, roots = ROOTS, examples = EXAMPLES) {
  const sources = readRoots(root, roots);
  const found = [
    ...sources.flatMap(checkRoot),
    ...privatePackages(sources, readRoots(root, examples)),
  ];
  const key = (v) => `${v.path} ${v.rule} ${v.detail}`;

  return found.sort((a, b) => key(a).localeCompare(key(b)));
}

/** A violation's ratchet entry: its rule, then the file imported, if any. */
function ratchetEntry(v) {
  return v.target === undefined ? v.rule : `${v.rule} ${v.target}`;
}

/**
 * Violations against the ratchet: `unlisted` ones fail the check, and so do
 * `fixed` ratchet entries that no longer occur (fixed, renamed or removed).
 */
export function compare(violations, ratchet) {
  const listed = (v) => (ratchet[v.path] ?? []).includes(ratchetEntry(v));
  const occurs = (path, entry) =>
    violations.some((v) => v.path === path && ratchetEntry(v) === entry);
  const fixed = Object.entries(ratchet).flatMap(([path, entries]) =>
    entries
      .filter((entry) => !occurs(path, entry))
      .map((rule) => ({ path, rule })),
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
