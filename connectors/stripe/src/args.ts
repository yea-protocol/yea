/** The `yea-stripe` command line. */

export const USAGE = `usage: yea-stripe [--http <port>] [--host <address>]
       yea-stripe --service-key

  stdio by default. --http serves Streamable HTTP on 127.0.0.1 (or --host), and needs
  YEA_HTTP_TOKEN (a bearer token every request carries) and YEA_SUB (who it acts for).
  --service-key prints the server's public key, for \`yea grant --to\`.

  The key: STRIPE_SECRET_KEY_FILE (a file only this user can read) or STRIPE_SECRET_KEY.
  The policy: YEA_PRINCIPAL_PUB, YEA_POLICY, ~/.yea/policy.json.`;

export interface Args {
  http: number | null;
  host: string;
  serviceKey: boolean;
}

const PORT = /^\d{1,5}$/;

/** A port number, or throw. */
function port(value: string | undefined): number {
  if (
    !value ||
    !PORT.test(value) ||
    Number(value) < 1 ||
    Number(value) > 65_535
  ) {
    throw new Error(
      `--http needs a port, got ${JSON.stringify(value)}\n${USAGE}`,
    );
  }

  return Number(value);
}

/** Read the command line; throws on anything it doesn't know. */
export function parseArgs(argv: string[]): Args {
  const out: Args = { http: null, host: '127.0.0.1', serviceKey: false };
  const rest = [...argv];

  while (rest.length) {
    const flag = rest.shift();

    if (flag === '--http') {
      out.http = port(rest.shift());
    } else if (flag === '--host' && rest[0]) {
      out.host = rest.shift() ?? out.host;
    } else if (flag === '--service-key') {
      out.serviceKey = true;
    } else {
      throw new Error(`unexpected ${JSON.stringify(flag)}\n${USAGE}`);
    }
  }

  return out;
}
