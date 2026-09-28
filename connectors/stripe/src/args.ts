/** The `yea-stripe` command line. */

export const USAGE = `usage: yea-stripe [--http <port>] [--host <address>]

  stdio by default. --http serves Streamable HTTP on 127.0.0.1 (or --host), and needs
  YEA_HTTP_TOKEN (a bearer token every request carries) and YEA_SUB (who it acts for).

  The key: STRIPE_SECRET_KEY_FILE (a file only this user can read) or STRIPE_SECRET_KEY.
  The policy: YEA_PRINCIPAL_PUB, YEA_POLICY, ~/.yea/policy.json.`;

export interface Args {
  http: number | null;
  host: string;
}

/** Read the command line; throws on anything it doesn't know. */
export function parseArgs(argv: string[]): Args {
  const out: Args = { http: null, host: '127.0.0.1' };
  const rest = [...argv];

  while (rest.length) {
    const flag = rest.shift();
    const value = rest.shift();

    if (
      flag === '--http' &&
      value &&
      /^\d{1,5}$/.test(value) &&
      Number(value) <= 65_535
    ) {
      out.http = Number(value);
    } else if (flag === '--host' && value) {
      out.host = value;
    } else {
      throw new Error(`unexpected ${JSON.stringify(flag)}\n${USAGE}`);
    }
  }

  return out;
}
