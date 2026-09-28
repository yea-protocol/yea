/** The built `yea-stripe` binary (CI builds before it tests; skipped when dist is missing). */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { tmp } from './helpers.js';

const bin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** Run the binary with only these variables (and PATH), and collect what it says. */
const run = (args: string[], env: Record<string, string>) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { PATH: process.env.PATH ?? '', ...env }, timeout: 10_000 },
      (e, stdout, stderr) => {
        resolve({ code: e ? Number(e.code ?? 1) : 0, stdout, stderr });
      },
    );
  });

describe.skipIf(!existsSync(bin))('yea-stripe', () => {
  it('--service-key prints the server’s public key, for yea grant --to', async () => {
    const r = await run(['--service-key'], { YEA_HOME: tmp() });

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/);
  });

  it('refuses to start without a key, saying what to set', async () => {
    const r = await run([], { YEA_HOME: tmp() });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/yea-stripe: set STRIPE_SECRET_KEY_FILE/);
  });

  it('refuses --http without a token and a sub', async () => {
    const r = await run(['--http', '8787'], {
      YEA_HOME: tmp(),
      STRIPE_SECRET_KEY: 'sk_test_51abcDEF',
    });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--http needs YEA_HTTP_TOKEN/);
  });

  it('serves the four tools and undo on stdio', async () => {
    const client = new Client({ name: 'c', version: '1' });

    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bin],
        env: {
          PATH: process.env.PATH ?? '',
          YEA_HOME: tmp(),
          STRIPE_SECRET_KEY: 'sk_test_51abcDEF',
        },
        stderr: 'pipe',
      }),
    );

    try {
      const { tools } = await client.listTools();

      expect(tools.map((t) => t.name).sort()).toEqual([
        'cancel_subscription',
        'change_plan',
        'customer',
        'refund',
        'undo',
      ]);
    } finally {
      await client.close();
    }
  });
});
