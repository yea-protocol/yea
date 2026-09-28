#!/usr/bin/env node
/** yea — command line for the YEA protocol. The commands live in ./cli/, one module per group. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cmdApprove } from './cli/approve.js';
import { cmdDoctor } from './cli/doctor.js';
import {
  cmdDelegate,
  cmdGrant,
  cmdGrantImport,
  cmdInit,
  cmdInspect,
  cmdServiceId,
  cmdWhoami,
} from './cli/identity.js';
import {
  cmdAdd,
  cmdInstall,
  cmdRemove,
  cmdServices,
  cmdUninstall,
} from './cli/install.js';
import {
  cmdDemo,
  cmdExamples,
  cmdMcp,
  cmdOpenapi,
  cmdTestDrive,
} from './cli/run.js';
import {
  type Command,
  client,
  die,
  type Options,
  parseCommandLine,
  type ServiceCommand,
} from './cli/shared.js';
import {
  cmdAsk,
  cmdCommit,
  cmdDo,
  cmdExpand,
  cmdHello,
  cmdIntent,
  cmdUndo,
} from './cli/talk.js';
import { home } from './home.js';
import { printable } from './text.js';

export { die } from './cli/shared.js';

const HELP = `yea — the protocol agents speak

get started
  yea install [--target claude-code,cursor,codex,gemini,vscode,windsurf,claude-desktop] [--local] [--with-principal]
                                           keys, a safe default policy, the MCP bridge and agent instructions (auto-detects tools)
  yea add <url>                         add a service for your AI tools (yea services · yea remove <url>)
  yea doctor                            check keys, grants, services and AI-tool registration
  yea uninstall [--target …]            remove YEA from your AI tools

identity
  yea init                              create your principal key and an agent key in ${home()}
  yea whoami                            show public keys
  yea service-id <name>                 an MCP server's service id, for yea grant --to (servers with a custom key path log it at start-up)
  yea grant [caveats]                   principal → agent grant (saved; used automatically)
  yea grant-import <token>              save a grant issued to this machine's agent key (principal kept elsewhere)
  yea delegate <token> --to <key> [caveats]   attenuate a grant for a sub-agent
  yea inspect <token>                   decode a grant chain
  yea approve <pc1.code> [--to <key>]   review and sign a one-time consent for one proposal

talk to a service  (url: yea://host:port · yeas://… · http(s)://…/yea · "stdio:cmd args")
  yea hello  <url>
  yea ask    <url> <capability> [key=value …]
  yea intent <url> <capability> [key=value …] [--goal "…"]
  yea commit <url> <proposal-id> <hash>
  yea undo   <url> <receipt-id>
  yea expand <url> <handle>
  yea do     <url> <capability> [key=value …]   intent → choose → commit, with consent prompts

try it
  yea test-drive [--model m] ["task"]  watch a real Claude model use YEA live (needs an Anthropic API key)
  yea demo                              narrated end-to-end demo (two services, consent, undo, sub-agents)
  yea examples [--port 7447] [--host]            serve the example calendar (7447), shop (7449) and billing (7451), trusting your principal

bridges
  yea mcp <url> [<url> …] [--tools generic|per-capability]
                                           run an MCP server (stdio): one tool per capability (@yea-protocol/cli)
  yea openapi <spec.json|url> [--base <url>] [--header "K: V"] [--port 7447] [--http 8080] [--preset github|petstore]
                                           serve any REST API as a YEA service (writes become proposals)

caveats: --svc <id> --can <pattern> --verbs ASK,INTENT --exp 24h --each spend=50.00USD --total emails=20 --risk low|medium|high
options: --budget <tokens> --json`;

const COMMANDS = new Map<string, Command>([
  ['init', cmdInit],
  ['whoami', cmdWhoami],
  ['service-id', cmdServiceId],
  ['grant', cmdGrant],
  ['grant-import', cmdGrantImport],
  ['delegate', cmdDelegate],
  ['inspect', cmdInspect],
  ['approve', cmdApprove],
  ['test-drive', cmdTestDrive],
  ['demo', cmdDemo],
  ['examples', cmdExamples],
  ['openapi', cmdOpenapi],
  ['mcp', cmdMcp],
  ['add', cmdAdd],
  ['remove', cmdRemove],
  ['services', cmdServices],
  ['setup', cmdInstall],
  ['install', cmdInstall],
  ['uninstall', cmdUninstall],
  ['doctor', cmdDoctor],
]);

const SERVICE_COMMANDS = new Map<string, ServiceCommand>([
  ['hello', cmdHello],
  ['ask', cmdAsk],
  ['intent', cmdIntent],
  ['commit', cmdCommit],
  ['undo', cmdUndo],
  ['expand', cmdExpand],
  ['do', cmdDo],
]);

async function main(o: Options, args: string[]) {
  const [cmd, ...rest] = args;

  if (!cmd || o.help) {
    return console.log(HELP);
  }

  const command = COMMANDS.get(cmd);

  if (command) {
    return command(rest, o);
  }

  const [url, ...more] = rest;

  if (!url) {
    die(HELP);
  }

  const c = await client(url, o);

  try {
    const talk =
      SERVICE_COMMANDS.get(cmd) ?? die(`unknown command ${cmd}\n\n${HELP}`);

    await talk(c, more, o);
  } finally {
    c.close();
  }
}

/**
 * Run the `yea` command line `argv` (the arguments after `yea`). A bad flag throws here, before
 * any command runs; a command's error is printed and exits with status 1, as `die` does.
 */
export function run(argv: string[]): Promise<void> {
  const { values: o, positionals: args } = parseCommandLine(argv);

  // An error can quote a service's reply (a JSON.parse SyntaxError does), escapes and all.
  return main(o, args).catch((e) =>
    die(`✗ ${printable((e as Error).message)}`),
  );
}

/** Whether node was started with this file (`node dist/cli.js …`) rather than importing it. */
function isEntry(): boolean {
  const script = process.argv[1];

  try {
    return !!script && realpathSync(script) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  await run(process.argv.slice(2));
}
