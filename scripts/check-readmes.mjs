/**
 * The READMEs: the root README, and each package's, which is its npm or PyPI page (#323).
 * Every code block in them is a pinned copy of a tested file's region
 * (check-readmes/snippets.mjs), and each package page installs its package and links its
 * guide and its SPEC absolutely (check-readmes/page.mjs). ts/README.md isn't checked here: it's
 * the root README, synced (sync-readme.mjs).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageProblems } from './check-readmes/page.mjs';
import { snippetProblems } from './check-readmes/snippets.mjs';
import { PYTHON_PROJECTS, publishedPackages } from './release-dry-run.mjs';

/** The npm package whose page is the root README, synced. */
const SYNCED = 'ts';

/** The name the Python project in `dir` under `root` publishes as. */
function pythonName(root, dir) {
  const toml = readFileSync(join(root, dir, 'pyproject.toml'), 'utf8');
  const name = /^name = "([^"]+)"$/m.exec(toml)?.[1];

  if (name === undefined) {
    throw new Error(`${dir}/pyproject.toml has no name`);
  }

  return name;
}

/** The package READMEs under `root`: each one's path, and the package it's the page of. */
export function packageReadmes(root) {
  const npm = publishedPackages(root).filter(({ dir }) => dir !== SYNCED);
  const python = PYTHON_PROJECTS.map((dir) => ({
    dir,
    name: pythonName(root, dir),
  }));

  return [...npm, ...python].map(({ dir, name }) => ({
    readme: `${dir}/README.md`,
    name,
  }));
}

/** A line for each problem with the READMEs under `root`. */
export function readmeProblems(root) {
  const read = (file) => readFileSync(join(root, file), 'utf8');
  const pages = packageReadmes(root).flatMap(({ readme, name }) => {
    if (!existsSync(join(root, readme))) {
      return [`${readme}: missing, so the package's page would be blank`];
    }

    const md = read(readme);

    return [
      ...snippetProblems(root, readme, md),
      ...pageProblems(readme, name, md),
    ];
  });

  return [...snippetProblems(root, 'README.md', read('README.md')), ...pages];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const problems = readmeProblems(root);

  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else {
    const count = packageReadmes(root).length + 1;

    console.log(`${count} READMEs: every snippet pinned, every page complete`);
  }
}
