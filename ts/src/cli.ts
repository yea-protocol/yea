#!/usr/bin/env node
/** yea — command line for the YEA protocol. The commands live in ./cli/, one module per group. */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Command,
  didYouMean,
  parseCommand,
  UsageError,
} from './cli/command.js';
import { COMMANDS } from './cli/commands.js';
import { commandHelp, usageMessage } from './cli/help.js';
import { die } from './cli/shared.js';
import { home } from './home.js';
import { printable } from './text.js';
import { isObject } from './util.js';
import { closest } from './validate.js';

export { UsageError } from './cli/command.js';
export { die } from './cli/shared.js';

/** A command's run function, given to `run` to use in place of the SDK's own. */
export type Runner = Command['run'];

/**
 * The help text. Built when it's shown: `home()` can move an old ~/.parley on first use.
 * `site/scripts/generate.mjs` reads it from this file for the CLI reference.
 */
const help = () => `yea — the protocol agents speak

usage: yea <command> [flags]

get started
  install       set YEA up for your AI tools: keys, a safe policy, the MCP bridge
  add           add a service for your AI tools
  remove        remove one
  services      list them
  doctor        check keys, grants, services and AI-tool registration
  uninstall     remove YEA from your AI tools

identity and policy
  init          create your principal key and an agent key in ${home()}
  whoami        show your public keys
  grant         sign a grant (your policy) from your principal to an agent
  grant-import  save a grant issued to this machine's agent key elsewhere
  delegate      narrow a grant for a sub-agent
  inspect       decode a grant chain
  approve       review a proposal and sign a one-time consent for it
  service-id    an MCP server's service id, for yea grant --to

talk to a service   <url>: yea://host:port · yeas://… · http(s)://…/yea · "stdio:cmd args"
  hello         a service's brief: who it is and what it can do
  ask           call a read-only capability
  intent        get proposals, without acting
  commit        carry out a proposal
  undo          undo a committed action
  expand        fetch more of a reply that was cut to its budget
  do            intent → choose → commit, with consent prompts

try it
  test-drive    watch a real Claude model use YEA live (needs an Anthropic API key)
  demo          a narrated end-to-end demo, no API key needed
  examples      serve the example calendar, shop and billing services

bridges
  mcp           the MCP server your AI tools run
  openapi       serve any REST API as a YEA service

flags
  -h, --help     show this help
  -v, --version  print the version

run 'yea help <command>' for a command's flags and an example`;

/** The flags `yea` takes before a command. */
const TOP_FLAGS = ['--help', '-h', '--version', '-v'];

/** This package's version, which is the `yea` command's: the npm packages share one version. */
function version(): string {
  const pkg: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );

  return isObject(pkg) && typeof pkg.version === 'string'
    ? pkg.version
    : 'unknown';
}

/** The command called `name`, or a `UsageError` naming the closest one. */
function find(name: string): Command {
  const command = COMMANDS.get(name);

  if (command) {
    return command;
  }

  const near = closest(
    name,
    [...COMMANDS.keys(), 'help'].filter((c) => c !== name),
  );

  throw new UsageError(
    `unknown command '${name}'`,
    didYouMean(near && `'${near}'`),
  );
}

/**
 * A `UsageError` for `flag`, given before any command: "did you mean" a top-level flag, or, when
 * the command in `argv` takes it, that flags go after the command.
 */
function topLevelFlagError(flag: string, argv: string[]): UsageError {
  const name = flag.replace(/^--?/, '').split('=')[0];
  const owner = argv.find((a) => {
    const flags = COMMANDS.get(a)?.flags;

    return !!flags && Object.hasOwn(flags, name);
  });
  const hint = owner
    ? `flags go after the command: yea ${owner} … ${flag}`
    : didYouMean(
        closest(
          flag,
          TOP_FLAGS.filter((f) => f !== flag),
        ),
      );

  return new UsageError(`unknown option ${flag}`, hint);
}

async function main(argv: string[], runners: Readonly<Record<string, Runner>>) {
  const [name, ...rest] = argv;

  if (name === undefined || name === '--help' || name === '-h') {
    return console.log(help());
  }

  if (name === '--version' || name === '-v') {
    return console.log(version());
  }

  if (name === 'help') {
    const topic = rest[0];
    const general = !topic || topic === 'help' || TOP_FLAGS.includes(topic);

    return console.log(general ? help() : commandHelp(find(topic)));
  }

  if (name.startsWith('-')) {
    throw topLevelFlagError(name, argv);
  }

  const command = find(name);

  try {
    const { args, values, help: wantsHelp } = parseCommand(command, rest);

    if (wantsHelp) {
      return console.log(commandHelp(command));
    }

    await (runners[name] ?? command.run)(args, values, argv);
  } catch (e) {
    fail(e, name);
  }
}

/**
 * Print why the command line failed and exit: status 2 for a usage error (with the command it
 * was made in, if any), else 1. YEA_DEBUG=1 also prints the stack trace.
 */
function fail(e: unknown, name?: string): never {
  const debug = !!process.env.YEA_DEBUG && process.env.YEA_DEBUG !== '0';

  if (debug && e instanceof Error && e.stack) {
    console.error(e.stack.split('\n').map(printable).join('\n'));
  }

  // A usage error quotes argv, which mustn't reach the terminal raw.
  if (e instanceof UsageError) {
    console.error(usageMessage(e, name).split('\n').map(printable).join('\n'));
    process.exit(2);
  }

  // An error can quote a service's reply (a JSON.parse SyntaxError does), escapes and all.
  return die(`✗ ${printable(e instanceof Error ? e.message : String(e))}`);
}

/**
 * Run the `yea` command line `argv` (the arguments after `yea`). A mistake on the command line
 * (an unknown command or flag) is printed with a hint and exits with status 2; a command's
 * error is printed and exits with status 1, as `die` does. `runners` run the commands this
 * package declares but can't run itself (`mcp` and `test-drive`, from @yea-protocol/cli); one
 * throws a `UsageError` for a bad flag value, to be reported the same way.
 */
export function run(
  argv: string[],
  runners: Readonly<Record<string, Runner>> = {},
): Promise<void> {
  return main(argv, runners).catch((e) => fail(e));
}

/**
 * Whether node was started with this file (`node dist/cli.js …`, or `node dist/cli`, which node
 * resolves to it) rather than importing it.
 */
function isEntry(): boolean {
  const script = process.argv[1];
  const self = realPath(fileURLToPath(import.meta.url));

  return (
    !!script &&
    !!self &&
    [script, `${script}.js`].some((p) => realPath(p) === self)
  );
}

/** `p` with every symlink resolved, or null if there's nothing there. */
function realPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

if (isEntry()) {
  await run(process.argv.slice(2));
}
