/**
 * The bins an installed package ships, each run as an adopter runs it (its
 * `node_modules/.bin` link, not through npx, which takes `--help` for itself)
 * with `--help`: it must exit 0 and print help, a usage line naming it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The bin names the installed package `pkg` in the project at `app` declares. */
export function binsOf(app, pkg) {
  const { name, bin } = JSON.parse(
    readFileSync(join(app, 'node_modules', pkg, 'package.json'), 'utf8'),
  );

  if (typeof bin === 'string') {
    return [name.replace(/^@[^/]+\//, '')];
  }

  return Object.keys(bin ?? {});
}

/**
 * True when a line of `text` opens like help for `bin`: `bin …` or
 * `usage: bin …`. Any line, not just the first: a dependency may print a
 * notice first (the Stripe SDK does, under some environments).
 */
function looksLikeHelp(text, bin) {
  return text
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .some(
      (line) => line.startsWith(`${bin} `) || line.startsWith(`usage: ${bin} `),
    );
}

/** The line of `text` that names an error, else its first. */
function errorIn(text) {
  const lines = text.trim().split('\n');

  return lines.find((line) => /Error\b/.test(line)) ?? lines[0];
}

/**
 * A line saying how `bin --help`, run in the project at `app`, fails: by not
 * starting, exiting non-zero, or printing something other than help. Empty
 * when it works. Help may go to stderr: a stdio MCP server keeps stdout for
 * the protocol.
 */
export function binProblems(app, bin) {
  const run = spawnSync(join(app, 'node_modules', '.bin', bin), ['--help'], {
    cwd: app,
    encoding: 'utf8',
  });
  const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;

  if (run.error) {
    return [`${bin} --help: ${run.error.message}`];
  }

  if (run.status !== 0) {
    return [`${bin} --help exited ${run.status}: ${errorIn(out)}`];
  }

  return looksLikeHelp(out, bin)
    ? []
    : [`${bin} --help printed no usage line: ${errorIn(out)}`];
}
