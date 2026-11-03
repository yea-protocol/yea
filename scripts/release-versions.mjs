/**
 * The release version, everywhere it's written: the four npm packages and
 * their internal dependency ranges, the two Python packages, server.json, the
 * plugin, the citation, the lockfiles, the versions the code reports, and
 * CHANGELOG's top heading. `set <x.y.z>` bumps them all in one step (all but
 * CHANGELOG, whose new section a person writes); `check` fails when any
 * disagrees with @yea-protocol/sdk's and, given the tag a release pushes,
 * when it isn't `v` and that version.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A release version: plain x.y.z, which npm and PyPI spell the same way. */
const VERSION = /^\d+\.\d+\.\d+$/;

/** A package.json's own version: the top-level key, two spaces in. */
const OWN_VERSION = /^ {2}"version": "([^"]+)"/m;

/** A pinned or caret range on a sibling package; `*` (a workspace link) isn't one. */
const SIBLING_RANGE = /"@yea-protocol\/[a-z-]+": "[\^~]?(\d[^"]*)"/g;

/** A Python project's own version, in pyproject.toml or uv.lock. */
const PROJECT_VERSION = (name) =>
  new RegExp(`name = "${name}"\\nversion = "([^"]+)"`, 'g');

/**
 * Every place the version lives. Each `pattern` captures the version in its
 * first group; a global one must hold it every time it matches. `bump: false`
 * marks a place `set` leaves to a person.
 */
export const SITES = [
  { file: 'ts/package.json', what: 'version', pattern: OWN_VERSION },
  { file: 'mcp/package.json', what: 'version', pattern: OWN_VERSION },
  { file: 'mcp/package.json', what: 'sdk range', pattern: SIBLING_RANGE },
  { file: 'cli/package.json', what: 'version', pattern: OWN_VERSION },
  { file: 'cli/package.json', what: 'sibling ranges', pattern: SIBLING_RANGE },
  {
    file: 'connectors/stripe/package.json',
    what: 'version',
    pattern: OWN_VERSION,
  },
  {
    file: 'connectors/stripe/package.json',
    what: 'sibling ranges',
    pattern: SIBLING_RANGE,
  },
  {
    file: 'package-lock.json',
    what: 'workspace versions',
    pattern: /"name": "@yea-protocol\/[a-z-]+",\n\s+"version": "([^"]+)"/g,
  },
  {
    file: 'package-lock.json',
    what: 'sibling ranges',
    pattern: SIBLING_RANGE,
  },
  {
    file: 'mcp/src/bridge.ts',
    what: 'VERSION',
    pattern: /const VERSION = '([^']+)'/,
  },
  {
    file: 'mcp/src/test-drive/host.ts',
    what: 'client version',
    pattern: /name: 'yea-test-drive', version: '([^']+)'/,
  },
  {
    file: 'connectors/stripe/src/server.ts',
    what: 'VERSION',
    pattern: /const VERSION = '([^']+)'/,
  },
  {
    file: 'python/pyproject.toml',
    what: 'version',
    pattern: PROJECT_VERSION('yea-sdk'),
  },
  {
    file: 'python/uv.lock',
    what: 'yea-sdk',
    pattern: PROJECT_VERSION('yea-sdk'),
  },
  {
    file: 'python/src/yea/__init__.py',
    what: '__version__',
    pattern: /^__version__ = "([^"]+)"/m,
  },
  {
    file: 'python/mcp/pyproject.toml',
    what: 'version',
    pattern: PROJECT_VERSION('yea-mcp'),
  },
  {
    file: 'python/mcp/pyproject.toml',
    what: 'yea-sdk range',
    pattern: /"yea-sdk>=([^"]+)"/,
  },
  {
    file: 'python/mcp/uv.lock',
    what: 'yea-mcp and yea-sdk',
    pattern: /name = "yea-(?:mcp|sdk)"\nversion = "([^"]+)"/g,
  },
  { file: 'server.json', what: 'versions', pattern: /"version": "([^"]+)"/g },
  {
    file: 'plugins/yea/.claude-plugin/plugin.json',
    what: 'version',
    pattern: OWN_VERSION,
  },
  { file: 'CITATION.cff', what: 'version', pattern: /^version: (\S+)/m },
  {
    file: 'CHANGELOG.md',
    what: 'top heading',
    pattern: /^## v?([^\s:]+)/m,
    bump: false,
  },
];

/** Every version `pattern` finds in `text`, in order. */
function versionsIn(text, pattern) {
  if (!pattern.global) {
    const match = pattern.exec(text);

    return match ? [match[1]] : [];
  }

  return [...text.matchAll(pattern)].map((m) => m[1]);
}

/** `text` with the version `pattern` captures set to `version` every time. */
function withVersion(text, pattern, version) {
  return text.replace(pattern, (match, old) => match.replace(old, version));
}

/** The version every site should hold: @yea-protocol/sdk's own. */
export function currentVersion(root) {
  const text = readFileSync(join(root, SITES[0].file), 'utf8');

  return versionsIn(text, SITES[0].pattern)[0];
}

/**
 * Each place under `root` that doesn't hold `expected`, as a line naming the
 * file, what it is and what it holds instead. Empty when they all agree.
 */
export function disagreements(root, expected = currentVersion(root)) {
  return SITES.flatMap(({ file, what, pattern }) => {
    const found = versionsIn(readFileSync(join(root, file), 'utf8'), pattern);
    const wrong = found.filter((v) => v !== expected);

    if (found.length === 0) {
      return [`${file} (${what}): not found`];
    }

    return wrong.length === 0
      ? []
      : [`${file} (${what}): ${wrong.join(', ')}, expected ${expected}`];
  });
}

/** A line when `tag` isn't the one a release of `version` pushes. */
export function tagProblems(tag, version) {
  return tag === `v${version}`
    ? []
    : [`tag ${tag} isn't v${version}, the version every package holds`];
}

/** The places `set` bumps. */
const BUMPED = SITES.filter(({ bump = true }) => bump);

/**
 * Sets every bumpable place under `root` to `version`. Writes nothing, and
 * throws, when one has gone missing, so a bump never skips a place silently.
 */
export function setVersion(root, version) {
  if (!VERSION.test(version)) {
    throw new Error(`"${version}" isn't a release version (x.y.z)`);
  }

  const missing = BUMPED.filter(
    ({ file, pattern }) =>
      versionsIn(readFileSync(join(root, file), 'utf8'), pattern).length === 0,
  );

  if (missing.length > 0) {
    throw new Error(
      missing
        .map(({ file, what }) => `${file} (${what}): not found`)
        .join('\n'),
    );
  }

  for (const { file, pattern } of BUMPED) {
    const path = join(root, file);

    writeFileSync(
      path,
      withVersion(readFileSync(path, 'utf8'), pattern, version),
    );
  }
}

/** `lines` under `heading`, indented. */
function listed(lines, heading) {
  return `${heading}\n${lines.map((line) => `  ${line}`).join('\n')}`;
}

/** Prints `left`, if any, as what remains for a person to do. */
function note(left, heading) {
  if (left.length > 0) {
    console.log(listed(left, heading));
  }
}

/** Prints `problems` and sets a failing exit code; true when there are none. */
function report(problems, heading) {
  if (problems.length > 0) {
    console.error(listed(problems, heading));
    process.exitCode = 1;
  }

  return problems.length === 0;
}

/** `set <version>`: bumps, then says what's left; a refusal says why. */
function set(root, version) {
  try {
    setVersion(root, version);
  } catch (error) {
    return report([error.message], `Can't set ${version}:`);
  }

  console.log(`Set every version to ${version}.`);
  note(disagreements(root, version), 'Still to do by hand:');
}

/** `check [<tag>]`: every version agrees, and with the tag, if one is given. */
function check(root, tag) {
  const version = currentVersion(root);
  const problems = [
    ...disagreements(root, version),
    ...(tag ? tagProblems(tag, version) : []),
  ];

  if (report(problems, 'Versions disagree:')) {
    console.log(`Every version is ${version}.`);
  }
}

/** The command: `check [<tag>]`, or `set <x.y.z>`. */
function main([command, arg], root) {
  if (command === 'check') {
    check(root, arg);
  } else if (command === 'set' && arg) {
    set(root, arg);
  } else {
    report(['release-versions.mjs check [<tag>] | set <x.y.z>'], 'Usage:');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), fileURLToPath(new URL('..', import.meta.url)));
}
