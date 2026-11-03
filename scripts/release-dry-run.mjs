/**
 * The release dry run (#318): everything release.yml would publish, packed,
 * installed and run. CI runs it on every PR, and release.yml runs it, given
 * the tag, before anything publishes. It checks that the versions agree (and,
 * given a tag, that CHANGELOG and the tag name that version), that the SDK's
 * npm README is synced, that server.json matches its schema, that the npm
 * tarballs install into an empty project and work, and that the Python wheels
 * install and import. Run it after `npm run build`; it needs uv for the
 * Python half. Usage: release-dry-run.mjs [<tag>]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNpm } from './release-dry-run/npm.mjs';
import { checkPython } from './release-dry-run/python.mjs';
import { checkServerJson } from './release-dry-run/server-json.mjs';
import { releaseProblems } from './release-versions.mjs';
import { readmeInSync } from './sync-readme.mjs';

/** The steps, in order; each throws to fail, and gets its own empty folder. */
const STEPS = [
  { name: 'versions agree', run: checkVersions },
  { name: "the SDK's npm README is synced", run: checkReadme },
  { name: 'server.json matches its $schema', run: checkServerJson },
  { name: 'npm tarballs install and run', run: checkNpm },
  { name: 'Python wheels install and import', run: checkPython },
];

/** Throws, listing them, when the versions keep `root` from release as `tag`. */
function checkVersions(root, _work, tag) {
  const problems = releaseProblems(root, tag);

  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
}

/** Throws when ts/README.md has drifted from the root README. */
function checkReadme(root) {
  if (!readmeInSync(root)) {
    throw new Error(
      'ts/README.md is out of sync: run node scripts/sync-readme.mjs',
    );
  }
}

/** Runs `step` in a fresh temp folder; true when it passes. */
async function passes(step, root, tag) {
  const work = mkdtempSync(join(tmpdir(), 'yea-release-'));

  try {
    await step.run(root, work, tag);
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
async function main(root, tag) {
  let failed = 0;

  for (const step of STEPS) {
    failed += (await passes(step, root, tag)) ? 0 : 1;
  }

  if (failed > 0) {
    console.error(`\n${failed} of ${STEPS.length} release checks failed.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(fileURLToPath(new URL('..', import.meta.url)), process.argv[2]);
}
