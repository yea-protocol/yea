/**
 * The release dry run (#318): everything release.yml would publish, packed,
 * installed and run before anyone tags. It checks that the versions agree,
 * that server.json matches its schema, that the npm tarballs install into an
 * empty project and work, and that the Python wheels install and import.
 * Run it after `npm run build`; it needs uv for the Python half.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNpm } from './release-dry-run/npm.mjs';
import { checkPython } from './release-dry-run/python.mjs';
import { checkServerJson } from './release-dry-run/server-json.mjs';
import { disagreements } from './release-versions.mjs';

/** The steps, in order; each throws to fail, and gets its own empty folder. */
const STEPS = [
  { name: 'versions agree', run: checkVersions },
  { name: 'server.json matches its $schema', run: checkServerJson },
  { name: 'npm tarballs install and run', run: checkNpm },
  { name: 'Python wheels install and import', run: checkPython },
];

/** Throws, listing them, when any version disagrees. */
function checkVersions(root) {
  const problems = disagreements(root);

  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
}

/** Runs `step` in a fresh temp folder; true when it passes. */
async function passes(step, root) {
  const work = mkdtempSync(join(tmpdir(), 'yea-release-'));

  try {
    await step.run(root, work);
    console.log(`ok    ${step.name}`);

    return true;
  } catch (error) {
    console.error(`FAIL  ${step.name}\n${indent(error.message)}`);

    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** `text` indented under its step. */
function indent(text) {
  return text.replace(/^/gm, '      ');
}

/** Runs every step, so one run reports every failure. */
async function main(root) {
  let failed = 0;

  for (const step of STEPS) {
    failed += (await passes(step, root)) ? 0 : 1;
  }

  if (failed > 0) {
    console.error(`\n${failed} of ${STEPS.length} release checks failed.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(fileURLToPath(new URL('..', import.meta.url)));
}
