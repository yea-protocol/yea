#!/usr/bin/env node
/**
 * `yea-stripe`: the MCP server for the Stripe API, on stdio by default, or Streamable HTTP with
 * `--http <port>`. Not affiliated with, endorsed by, or sponsored by Stripe, Inc.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { yea } from '@yea-protocol/mcp';
import { errorMessage, isLiveKey } from './api.js';
import { parseArgs, USAGE } from './args.js';
import { httpApp, httpAuthFrom, serveHttp, subOf } from './http.js';
import { readSecretKey } from './key.js';
import { NAME, stripeServer } from './server.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

async function main(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.error(USAGE);

    return;
  }

  const args = parseArgs(argv);

  if (args.serviceKey) {
    // What `yea grant --to` needs; no Stripe key required.
    console.log(await yea({ name: NAME, transport: 'stdio' }).serviceId());

    return;
  }

  const key = readSecretKey();
  const mode = isLiveKey(key) ? 'LIVE' : 'test';

  if (args.http === null) {
    const approvals = yea({ name: NAME, transport: 'stdio' });

    serveStdio(stripeServer({ key, approvals }));
    console.error(
      `${NAME}: ${mode} mode, on stdio; service key ${await approvals.serviceId()}`,
    );

    return;
  }

  const auth = httpAuthFrom();
  // One process serves every request, so approvals can live in memory. There is no shared
  // store for `yea approve`, so plans that need it (live high-risk ones) can't run here.
  const approvals = yea({
    name: NAME,
    transport: 'http',
    singleProcess: true,
    sub: subOf,
  });
  const app = httpApp(stripeServer({ key, approvals }), {
    ...auth,
    loopback: LOOPBACK.has(args.host),
  });

  await serveHttp(app, { port: args.http, host: args.host });
  console.error(
    `${NAME}: ${mode} mode, on http://${args.host}:${args.http}/; service key ${await approvals.serviceId()}`,
  );
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`${NAME}: ${errorMessage(e)}`);
  process.exit(1);
});
