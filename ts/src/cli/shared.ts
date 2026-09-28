/** What every `yea` command group uses: the flags, `die`, a client and a terminal prompt. */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { Client } from '../client.js';
import { agentKey, loadGrants } from '../home.js';
import { connect } from '../node.js';

/** The command line, parsed: every flag any command takes, and the positionals. */
export function parseCommandLine(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      svc: { type: 'string', multiple: true },
      can: { type: 'string', multiple: true },
      verbs: { type: 'string' },
      exp: { type: 'string' },
      each: { type: 'string', multiple: true },
      total: { type: 'string', multiple: true },
      risk: { type: 'string' },
      to: { type: 'string' },
      goal: { type: 'string' },
      budget: { type: 'string' },
      expires: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      name: { type: 'string' },
      model: { type: 'string' },
      base: { type: 'string' },
      header: { type: 'string', multiple: true },
      port: { type: 'string' },
      http: { type: 'string' },
      id: { type: 'string' },
      prefix: { type: 'string' },
      target: { type: 'string' },
      local: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'no-principal': { type: 'boolean' },
      'with-principal': { type: 'boolean' },
      host: { type: 'string' },
      preset: { type: 'string' },
    },
  });
}

/** The flags given on the command line. */
export type Options = ReturnType<typeof parseCommandLine>['values'];

/**
 * A command that works locally (keys, grants, setup, servers). `argv` is the whole command
 * line given to `run`, for a command that runs `yea` again.
 */
export type Command = (
  rest: string[],
  o: Options,
  argv: string[],
) => Promise<void>;

/** A command that talks to the service at the first argument; `args` are the rest. */
export type ServiceCommand = (
  c: Client,
  args: string[],
  o: Options,
) => Promise<void>;

/** Print `msg` on stderr and exit with status 1. */
export function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** A client for the service at `url`, holding this machine's agent key, grants and consents. */
export async function client(url: string, o: Options): Promise<Client> {
  const agent = await agentKey();

  return connect(url, {
    key: agent?.seed,
    grants: [...loadGrants('grants'), ...loadGrants('consents')],
    name: o.name ?? 'yea-cli',
    budget: o.budget ? Number(o.budget) : undefined,
  });
}

/** Ask a yes/no question on the terminal; only an answer starting with y counts as yes. */
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const yes = /^y/i.test(await rl.question(question));

  rl.close();

  return yes;
}
