/**
 * Where the Stripe key comes from: `STRIPE_SECRET_KEY_FILE`, a file only the server's OS user
 * can read, or `STRIPE_SECRET_KEY`. It is the opposite of the principal key file: the secret
 * must be readable by the server and nobody else.
 *
 * Whatever the server can read, an agent running as the same OS user can read too. Only a
 * separate OS user for the server, or a remote server, keeps the key from the agent.
 */
import { readPrivateFile } from '@yea-protocol/sdk/node';

/** Stripe keys are one token of letters, digits and underscores. */
const KEY = /^[A-Za-z0-9_]{8,256}$/;

/** A key as the file or variable holds it, checked so it can't smuggle anything into a header. */
function checkKey(key: string, from: string): string {
  const k = key.trim();

  if (!KEY.test(k)) {
    throw new Error(`${from} does not hold a Stripe key (sk_… or rk_…)`);
  }

  return k;
}

/**
 * The key in a file only the server's OS user can read (`readPrivateFile`: no symlink, owned by
 * `owner`, 0600 or 0400). `owner` is the user the file must belong to: the one running the server.
 */
export function readKeyFile(path: string, owner?: number): string {
  const text = readPrivateFile(path, {
    label: 'STRIPE_SECRET_KEY_FILE',
    owner,
  });

  return checkKey(text, path);
}

/**
 * The Stripe key: the file `STRIPE_SECRET_KEY_FILE` names, checked, else `STRIPE_SECRET_KEY`.
 * A file that fails its check is refused, never skipped for the variable.
 */
export function readSecretKey(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STRIPE_SECRET_KEY_FILE) {
    return readKeyFile(env.STRIPE_SECRET_KEY_FILE);
  }

  if (env.STRIPE_SECRET_KEY) {
    return checkKey(env.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY');
  }

  throw new Error(
    'set STRIPE_SECRET_KEY_FILE (a file only you can read: chmod 600) or STRIPE_SECRET_KEY',
  );
}
