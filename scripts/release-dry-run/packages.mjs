/**
 * What a release publishes to npm: every root workspace whose package.json
 * isn't private. release.yml names each one twice (to pack it, then to publish
 * its tarball), and a package it leaves out is reported, so a new workspace
 * can't miss a release unseen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The JSON file at `path`. */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The repo's publishable npm packages under `root`: each one's name and folder. */
export function publishedPackages(root) {
  const { workspaces } = readJson(join(root, 'package.json'));

  return workspaces
    .map((dir) => ({
      dir,
      manifest: readJson(join(root, dir, 'package.json')),
    }))
    .filter(({ manifest }) => !manifest.private)
    .map(({ dir, manifest }) => ({ name: manifest.name, dir }));
}

/** A tarball's name stem as `npm pack` writes it: `@a/b` packs as `a-b-<version>.tgz`. */
function tarballStem(name) {
  return name.replace(/^@/, '').replace('/', '-');
}

/**
 * A line for each of `packages` the release workflow `workflow` (its text)
 * doesn't pack with `-w <name>` or doesn't `npm publish`.
 */
export function unreleased(workflow, packages) {
  return packages.flatMap(({ name }) => [
    ...(workflow.includes(`-w ${name}`)
      ? []
      : [`release.yml doesn't pack ${name}`]),
    ...(workflow.includes(`npm publish npm-dist/${tarballStem(name)}-`)
      ? []
      : [`release.yml doesn't publish ${name}`]),
  ]);
}
