/** The `yea-stripe` command line. */
import { parseArgs as parse } from 'node:util';
import { errorMessage } from './context.js';

export const USAGE = `usage: yea-stripe [--http <port>] [--host <address>]
       yea-stripe --service-key

  stdio by default. --http serves Streamable HTTP on 127.0.0.1 (or --host), and needs
  YEA_HTTP_TOKEN (a bearer token every request carries) and YEA_SUB (who it acts for).
  --service-key prints the server's public key, for \`yea grant --to\`.

  The key: STRIPE_SECRET_KEY_FILE (a file only this user can read) or STRIPE_SECRET_KEY.
  The policy: YEA_PRINCIPAL_PUB, YEA_POLICY, ~/.yea/policy.json.`;

const OPTIONS = {
  http: { type: 'string' },
  host: { type: 'string', default: '127.0.0.1' },
  'service-key': { type: 'boolean', default: false },
} as const;

const PORT = /^\d{1,5}$/;

/** A port number, or throw. */
function port(value: string): number {
  if (!PORT.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(
      `--http needs a port, got ${JSON.stringify(value)}\n${USAGE}`,
    );
  }

  return Number(value);
}

/** The flags as given; throws, with the usage, on anything it doesn't know. */
function flags(argv: string[]) {
  try {
    return parse({ args: argv, options: OPTIONS, strict: true }).values;
  } catch (e) {
    throw new Error(`${errorMessage(e)}\n${USAGE}`);
  }
}

/** Read the command line; throws on anything it doesn't know. */
export function parseArgs(argv: string[]) {
  const v = flags(argv);

  // An empty host would listen on every interface.
  if (!v.host) {
    throw new Error(`--host needs an address\n${USAGE}`);
  }

  return {
    http: v.http === undefined ? null : port(v.http),
    host: v.host,
    serviceKey: v['service-key'],
  };
}
