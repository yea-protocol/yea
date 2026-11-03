/**
 * What every `yea` command group uses: `die`, a client and its flags, a terminal prompt and the
 * install scope.
 */
import { createInterface } from 'node:readline/promises';
import type { Client } from '../client.js';
import { agentKey, loadGrants } from '../home.js';
import { connect } from '../node.js';
import type { Flag, Flags, Values } from './command.js';

/** The flags of a command that connects to a service, read by `client`. */
export const CONNECT_FLAGS = {
  name: {
    type: 'string',
    value: 'name',
    help: 'the agent name the service sees (default yea-cli)',
  },
  budget: {
    type: 'string',
    value: 'tokens',
    help: 'the default token budget for replies',
  },
} as const satisfies Flags;

/** `--local`, read by `installScope`. */
export const LOCAL_FLAG = {
  type: 'boolean',
  help: "this project's files instead of your user-level ones",
} as const satisfies Flag;

/** Print `msg` on stderr and exit with status 1. */
export function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** A client for the service at `url`, holding this machine's agent key, grants and consents. */
export async function client(
  url: string,
  o: Values<typeof CONNECT_FLAGS>,
): Promise<Client> {
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

/** Where to install for AI tools: this project (--local) or the user's home. */
export const installScope = (o: { local?: boolean }) => ({
  local: !!o.local,
  cwd: process.cwd(),
});
