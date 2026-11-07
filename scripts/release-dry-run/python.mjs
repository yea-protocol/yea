/**
 * The Python half of the dry run: build yea-sdk and yea-mcp as release.yml
 * does, install the wheels into a fresh venv, import both, run `twine check`
 * on everything PyPI would get, and, given a tag, check that no sdist's README
 * says "Unreleased".
 */
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { unreleasedReadme } from './readme.mjs';
import { sh } from './shell.mjs';

/** The packages release.yml publishes, by folder. */
export const PYTHON_PROJECTS = ['python', 'python/mcp'];

/** The newest Python CI tests on, for the venv the wheels go into. */
const PYTHON = '3.13';

/** Pinned so a dry run checks the same things every time. */
const TWINE = 'twine@7.0.0';

/** Every file in `dir` whose name matches `pattern`, as paths. */
function filesIn(dir, pattern) {
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => join(dir, name));
}

/** Throws when an sdist in `dist` has a README that says "Unreleased". */
function checkBanners(dist) {
  const problems = filesIn(dist, /\.tar\.gz$/).flatMap((sdist) => {
    const stem = basename(sdist, '.tar.gz');

    return unreleasedReadme(stem, sdist, `${stem}/README.md`);
  });

  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
}

/**
 * Builds, installs, imports and checks the Python packages from the repo at
 * `root`, working in the empty folder `work`, as a release of `tag` (if given)
 * would. Throws on the first failure.
 */
export function checkPython(root, work, tag) {
  const dist = join(work, 'python-dist');
  const venv = join(work, 'venv');
  const python = join(venv, 'bin', 'python');

  for (const project of PYTHON_PROJECTS) {
    sh('uv', ['build', '--no-sources', '--out-dir', dist], {
      cwd: join(root, project),
    });
  }

  sh('uv', ['venv', '--python', PYTHON, venv]);
  sh('uv', ['pip', 'install', '--python', python, ...filesIn(dist, /\.whl$/)]);
  sh(python, ['-I', '-c', 'import yea, yea_mcp']);
  sh('uvx', [TWINE, 'check', '--strict', ...filesIn(dist, /\.(whl|gz)$/)]);

  if (tag) {
    checkBanners(dist);
  }
}
