/**
 * The Python half of the dry run: build yea-sdk and yea-mcp as release.yml
 * does, install the wheels into a fresh venv, import both, and run
 * `twine check` on everything PyPI would get.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sh } from './shell.mjs';

/** The packages release.yml publishes, by folder. */
const PROJECTS = ['python', 'python/mcp'];

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

/**
 * Builds, installs, imports and checks the Python packages from the repo at
 * `root`, working in the empty folder `work`. Throws on the first failure.
 */
export function checkPython(root, work) {
  const dist = join(work, 'python-dist');
  const venv = join(work, 'venv');
  const python = join(venv, 'bin', 'python');

  for (const project of PROJECTS) {
    sh('uv', ['build', '--no-sources', '--out-dir', dist], {
      cwd: join(root, project),
    });
  }

  sh('uv', ['venv', '--python', PYTHON, venv]);
  sh('uv', ['pip', 'install', '--python', python, ...filesIn(dist, /\.whl$/)]);
  sh(python, ['-I', '-c', 'import yea, yea_mcp']);
  sh('uvx', [TWINE, 'check', '--strict', ...filesIn(dist, /\.(whl|gz)$/)]);
}
