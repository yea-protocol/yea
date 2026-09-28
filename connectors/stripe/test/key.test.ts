import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { readKeyFile, readSecretKey } from '../src/key.js';
import { TEST_KEY, tmp } from './helpers.js';

const keyFile = (mode = 0o600, body = `${TEST_KEY}\n`) => {
  const path = join(tmp(), 'stripe.key');

  writeFileSync(path, body, { mode });
  chmodSync(path, mode);

  return path;
};

describe('STRIPE_SECRET_KEY_FILE', () => {
  it('reads a 0600 file owned by the server’s user', () => {
    expect(readSecretKey({ STRIPE_SECRET_KEY_FILE: keyFile() })).toBe(TEST_KEY);
    expect(readKeyFile(keyFile(0o400))).toBe(TEST_KEY);
  });

  it.each([0o640, 0o604, 0o644, 0o660])(
    'refuses mode %o: others could read it',
    (mode) => {
      expect(() =>
        readSecretKey({ STRIPE_SECRET_KEY_FILE: keyFile(mode) }),
      ).toThrow(/can be read by other users \(chmod 600 it\)/);
    },
  );

  it('refuses a file another user owns', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;

    expect(() => readKeyFile(keyFile(), uid + 1)).toThrow(
      /is not owned by the user running the server/,
    );
  });

  it('refuses a symlink, even to a good key file', () => {
    const link = join(tmp(), 'link.key');

    symlinkSync(keyFile(), link);
    expect(() => readSecretKey({ STRIPE_SECRET_KEY_FILE: link })).toThrow(
      /is a symlink/,
    );
  });

  it('refuses a directory, a missing file, and a file that holds no key', () => {
    const dir = join(tmp(), 'dir');

    mkdirSync(dir, { mode: 0o700 });
    expect(() => readKeyFile(dir)).toThrow(/not a regular file/);
    expect(() => readKeyFile(join(tmp(), 'missing'))).toThrow(
      /refusing STRIPE_SECRET_KEY_FILE/,
    );
    expect(() => readKeyFile(keyFile(0o600, 'sk_test_a\nX-Evil: 1'))).toThrow(
      /does not hold a Stripe key/,
    );
    expect(() => readKeyFile(keyFile(0o600, ''))).toThrow(
      /does not hold a Stripe key/,
    );
  });

  it('a bad key file is refused, never skipped for STRIPE_SECRET_KEY', () => {
    expect(() =>
      readSecretKey({
        STRIPE_SECRET_KEY_FILE: keyFile(0o644),
        STRIPE_SECRET_KEY: TEST_KEY,
      }),
    ).toThrow(/chmod 600/);
  });
});

describe('STRIPE_SECRET_KEY', () => {
  it('works, trimmed, when there is no key file', () => {
    expect(readSecretKey({ STRIPE_SECRET_KEY: ` ${TEST_KEY}\n` })).toBe(
      TEST_KEY,
    );
  });

  it('refuses a value that isn’t one key', () => {
    expect(() => readSecretKey({ STRIPE_SECRET_KEY: 'sk_test_a b' })).toThrow(
      'STRIPE_SECRET_KEY does not hold a Stripe key (sk_… or rk_…)',
    );
  });

  it('says what to set when neither is', () => {
    expect(() => readSecretKey({})).toThrow(
      /set STRIPE_SECRET_KEY_FILE .* or STRIPE_SECRET_KEY/,
    );
  });
});

describe('the command line', () => {
  it('is stdio by default; --http takes a port, --host an address', () => {
    expect(parseArgs([])).toEqual({
      http: null,
      host: '127.0.0.1',
      serviceKey: false,
    });
    expect(parseArgs(['--http', '8787'])).toMatchObject({
      http: 8787,
      host: '127.0.0.1',
    });
    expect(parseArgs(['--http', '8787', '--host', '0.0.0.0'])).toMatchObject({
      http: 8787,
      host: '0.0.0.0',
    });
    expect(parseArgs(['--service-key']).serviceKey).toBe(true);
  });

  it.each([
    ['--http'],
    ['--http', 'x'],
    ['--http', '70000'],
    ['--nope'],
    ['--host'],
  ])('refuses %j', (...argv) => {
    expect(() => parseArgs(argv)).toThrow(/usage: yea-stripe/);
  });
});
