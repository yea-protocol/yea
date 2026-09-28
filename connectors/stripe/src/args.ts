/** The `yea-stripe` command line. */
import { parseArgs as parse } from 'node:util';
import { printable } from '@yea-protocol/sdk';
import { errorMessage } from './api.js';

export const USAGE = `usage: yea-stripe [--http <port>] [--host <address>]
       yea-stripe --service-key

  stdio by default. --http serves Streamable HTTP on 127.0.0.1 (or --host), and needs
  YEA_HTTP_TOKEN (a bearer token every request carries) and YEA_SUB (who it acts for).
  --service-key prints the server's public key, for \`yea grant --to\`.

  The key: STRIPE_SECRET_KEY_FILE (a file only this user can read) or STRIPE_SECRET_KEY.
  The policy: YEA_PRINCIPAL_PUB, YEA_POLICY, ~/.yea/policy.json.`;

// Each flag may repeat, as before: every value is checked, and the last one counts.
const OPTIONS = {
  http: { type: 'string', multiple: true },
  host: { type: 'string', multiple: true },
  'service-key': { type: 'boolean', default: false },
} as const;

const PORT = /^\d{1,5}$/;

const usageError = (why: string) => new Error(`${why}\n${USAGE}`);

/** A port number, or throw. */
function port(value: string | undefined): number {
  if (
    !value ||
    !PORT.test(value) ||
    Number(value) < 1 ||
    Number(value) > 65_535
  ) {
    throw usageError(`--http needs a port, got ${JSON.stringify(value)}`);
  }

  return Number(value);
}

/** An address to listen on; an empty one would listen on every interface. */
function host(value: string): string {
  if (!value) {
    throw usageError('--host needs an address');
  }

  return value;
}

/** Node's parse; its message quotes the argument, which could hold anything, so it's escaped. */
function parseOptions(argv: string[]) {
  try {
    return parse({ args: argv, options: OPTIONS, strict: true, tokens: true });
  } catch (e) {
    throw usageError(printable(errorMessage(e)));
  }
}

/**
 * The flags as given; throws, with the usage, on anything it doesn't know. `--http` with
 * nothing or another flag after it says it needs a port, rather than Node's wording.
 */
function flags(argv: string[]) {
  for (const [i, arg] of argv.entries()) {
    if (arg === '--http') {
      port(argv[i + 1]);
    }
  }

  const { values, tokens } = parseOptions(argv);

  if (tokens.some((t) => t.kind === 'option-terminator')) {
    throw usageError('unexpected "--"');
  }

  return values;
}

/** Read the command line; throws on anything it doesn't know. */
export function parseArgs(argv: string[]) {
  const v = flags(argv);

  return {
    http: (v.http ?? []).map((p) => port(p)).at(-1) ?? null,
    host: (v.host ?? []).map(host).at(-1) ?? '127.0.0.1',
    serviceKey: v['service-key'],
  };
}
