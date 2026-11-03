/**
 * The npm half of the dry run: pack the four packages release.yml publishes,
 * check each tarball holds everything its `files` folders do, install them
 * into an empty project as an adopter would, and run them: every export of
 * the three libraries loads, both bins answer `--help`, and `yea mcp` answers
 * `initialize`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportProblems } from './exports.mjs';
import { initialize } from './mcp-initialize.mjs';
import { sh } from './shell.mjs';
import { unpackedFiles } from './tarball.mjs';

/** What release.yml publishes, in its publish order, with each one's folder. */
const PACKAGES = [
  { name: '@yea-protocol/sdk', dir: 'ts' },
  { name: '@yea-protocol/mcp', dir: 'mcp' },
  { name: '@yea-protocol/cli', dir: 'cli' },
  { name: '@yea-protocol/stripe', dir: 'connectors/stripe' },
];

/** The libraries whose every `exports` entry must load. */
const LIBRARIES = [
  '@yea-protocol/sdk',
  '@yea-protocol/mcp',
  '@yea-protocol/stripe',
];

/** The bins an adopter runs, each of which must answer `--help`. */
const BINS = ['yea', 'yea-stripe'];

/** Throws, listing them, when there are `problems`. */
function fail(problems) {
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
}

/**
 * Packs `PACKAGES` from the repo at `root` into `dest`: each one's name, its
 * tarball's path and the paths in it.
 */
function pack(root, dest) {
  const workspaces = PACKAGES.flatMap(({ name }) => ['-w', name]);
  const out = sh(
    'npm',
    ['pack', ...workspaces, '--pack-destination', dest, '--json'],
    { cwd: root },
  );

  return JSON.parse(out).map(({ name, filename, files }) => ({
    name,
    tarball: join(dest, filename),
    paths: files.map(({ path }) => path),
  }));
}

/** Throws when a tarball in `packs` lacks a file its workspace under `root` has. */
function checkTarballs(root, packs) {
  fail(
    packs.flatMap(({ name, paths }) => {
      const { dir } = PACKAGES.find((p) => p.name === name) ?? {};

      return dir
        ? unpackedFiles(join(root, dir), paths)
        : [`npm pack made ${name}, which isn't one of the packages`];
    }),
  );
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

/**
 * Packs, installs and runs the npm packages from the repo at `root`, built,
 * working in the empty folder `work`. Throws on the first failure.
 */
export async function checkNpm(root, work) {
  const dist = join(work, 'npm-dist');
  const app = join(work, 'app');

  mkdirSync(dist);

  const packs = pack(root, dist);

  checkTarballs(root, packs);
  install(
    app,
    packs.map(({ tarball }) => tarball),
  );
  fail(LIBRARIES.flatMap((pkg) => exportProblems(app, pkg)));

  for (const bin of BINS) {
    sh('npx', ['--no', bin, '--help'], { cwd: app });
  }

  await checkMcp(app, join(work, 'home'));
}
