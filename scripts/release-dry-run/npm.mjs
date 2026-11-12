/**
 * The npm half of the dry run: the packages a release publishes (every
 * workspace that isn't private, each named in release.yml), packed; each
 * tarball holds everything its `files` folders do, and a README that, given a
 * tag, doesn't say the package is unreleased; then installed into an empty
 * project as an adopter would, and run: every export of the libraries loads,
 * every bin answers `--help`, and `yea mcp` answers `initialize`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binProblems, binsOf } from './bins.mjs';
import { exportProblems } from './exports.mjs';
import { initialize } from './mcp-initialize.mjs';
import { publishedPackages, unreleased } from './packages.mjs';
import { missingReadmes, unreleasedReadme } from './readme.mjs';
import { sh } from './shell.mjs';
import { unpackedFiles } from './tarball.mjs';

/** The libraries whose every `exports` entry must load. */
const LIBRARIES = [
  '@yea-protocol/sdk',
  '@yea-protocol/mcp',
  '@yea-protocol/stripe',
];

/** Throws, listing them, when there are `problems`. */
function fail(problems) {
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
}

/**
 * Packs `packages` from the repo at `root` into `dest`: each one's name, its
 * folder, its tarball's path and the paths in it.
 */
function pack(root, packages, dest) {
  const workspaces = packages.flatMap(({ name }) => ['-w', name]);
  const out = sh(
    'npm',
    ['pack', ...workspaces, '--pack-destination', dest, '--json'],
    { cwd: root },
  );

  return JSON.parse(out).map(({ name, filename, files }) => ({
    name,
    dir: packages.find((p) => p.name === name)?.dir,
    tarball: join(dest, filename),
    paths: files.map(({ path }) => path),
  }));
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
 * A line for each reason `packs`, the tarballs of `packages` from the repo at
 * `root`, can't be released: a package release.yml leaves out, a file or a
 * README a tarball lacks, or, given a `tag`, a packed README that still says
 * the package is unreleased. A tarball without a README is named once, as
 * that, not as an error reading it.
 */
export function packedProblems(root, packages, packs, tag) {
  const workflow = readFileSync(
    join(root, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const readmes = packs.filter(({ paths }) => paths.includes('README.md'));
  const banners = tag
    ? readmes.flatMap(({ name, tarball }) =>
        unreleasedReadme(name, tarball, 'package/README.md'),
      )
    : [];

  return [
    ...unreleased(workflow, packages),
    ...packs.flatMap(({ dir, paths }) => unpackedFiles(join(root, dir), paths)),
    ...missingReadmes(packs),
    ...banners,
  ];
}

/**
 * Packs, installs and runs the npm packages from the repo at `root`, built,
 * working in the empty folder `work`, as a release of `tag` (if given) would.
 * Throws on the first failure.
 */
export async function checkNpm(root, work, tag) {
  const packages = publishedPackages(root);
  const dist = join(work, 'npm-dist');
  const app = join(work, 'app');

  mkdirSync(dist);

  const packs = pack(root, packages, dist);

  fail(packedProblems(root, packages, packs, tag));
  install(
    app,
    packs.map(({ tarball }) => tarball),
  );
  fail(LIBRARIES.flatMap((pkg) => exportProblems(app, pkg)));
  fail(
    packages
      .flatMap(({ name }) => binsOf(app, name))
      .flatMap((bin) => binProblems(app, bin)),
  );
  await checkMcp(app, join(work, 'home'));
}
