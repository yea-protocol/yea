/** The `yea-stripe` command line (src/args.ts): its flags, and what it refuses. */
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';

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
    expect(parseArgs(['--http', '1', '--http=2']).http).toBe(2);
  });

  it.each<[string[], RegExp]>([
    [['--host', ''], /--host needs an address/],
    [['--host='], /--host needs an address/],
    [['--host', 'a', '--host', ''], /--host needs an address/],
    [['--http'], /--http needs a port, got undefined/],
    [['--http', 'x'], /--http needs a port, got "x"/],
    [['--http', '--service-key'], /--http needs a port, got "--service-key"/],
    [['--http', 'x', '--http', '8787'], /--http needs a port/],
    [['--http=8787', '--http=0'], /--http needs a port, got "0"/],
    [['--'], /unexpected "--"/],
    [['--http', '8787', '--'], /unexpected "--"/],
  ])('refuses %j, saying why', (argv, why) => {
    expect(() => parseArgs(argv)).toThrow(why);
  });

  it('escapes what an unknown flag says before it is printed', () => {
    expect(() => parseArgs(['--x\u001b[2J'])).toThrow(
      /^Unknown option '--x\\u\{1b\}\[2J'/,
    );
  });

  it.each([
    ['--http'],
    ['--http', 'x'],
    ['--http', '70000'],
    ['--http', '0'],
    ['--nope'],
    ['--host'],
  ])('refuses %j', (...argv) => {
    expect(() => parseArgs(argv)).toThrow(/usage: yea-stripe/);
  });
});
