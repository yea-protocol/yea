/**
 * The npm half of the dry run: pack the four packages release.yml publishes,
 * install the tarballs into an empty project as an adopter would, and run
 * them: every export of the two libraries loads, `npx yea --help` works, and
 * `yea mcp` answers `initialize`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportProblems } from './exports.mjs';
import { initialize } from './mcp-initialize.mjs';
import { sh } from './shell.mjs';

/** What release.yml publishes, in its publish order. */
const PACKAGES = [
  '@yea-protocol/sdk',
  '@yea-protocol/mcp',
  '@yea-protocol/cli',
  '@yea-protocol/stripe',
];

/** The libraries whose every `exports` entry must load. */
const LIBRARIES = ['@yea-protocol/sdk', '@yea-protocol/mcp'];

/** Packs `PACKAGES` from the repo at `root` into `dest`; their paths. */
function pack(root, dest) {
  const workspaces = PACKAGES.flatMap((name) => ['-w', name]);
  const out = sh(
    'npm',
    ['pack', ...workspaces, '--pack-destination', dest, '--json'],
    { cwd: root },
  );

  return JSON.parse(out).map(({ filename }) => join(dest, filename));
}

/** An empty project at `app` with `tarballs` installed, as an adopter's. */
function install(app, tarballs) {
  mkdirSync(app, { recursive: true });
  writeFileSync(
    join(app, 'package.json'),
    '{ "name": "release-dry-run", "private": true }\n',
  );
  sh('npm', ['install', '--no-audit', '--no-fund', ...tarballs], { cwd: app });
}

/** Throws when `yea mcp`, run from `app` with a fresh home, doesn't answer. */
async function checkMcp(app, home) {
  const env = { ...process.env, YEA_HOME: home };
  const info = await initialize(
    join(app, 'node_modules', '.bin', 'yea'),
    ['mcp'],
    { env },
  );

  if (typeof info.name !== 'string') {
    throw new Error(`yea mcp answered without a name: ${JSON.stringify(info)}`);
  }
}

/** Throws, listing them, when the libraries' exports have problems. */
function checkExports(app) {
  const problems = LIBRARIES.flatMap((pkg) => exportProblems(app, pkg));

  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
}

/**
 * Packs, installs and runs the npm packages from the repo at `root`, built,
 * working in the empty folder `work`. Throws on the first failure.
 */
export async function checkNpm(root, work) {
  const dist = join(work, 'npm-dist');
  const app = join(work, 'app');

  mkdirSync(dist);
  install(app, pack(root, dist));
  checkExports(app);
  sh('npx', ['--no', 'yea', '--help'], { cwd: app });
  await checkMcp(app, join(work, 'home'));
}
