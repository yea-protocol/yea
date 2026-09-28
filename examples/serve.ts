/**
 * Serve the example services.
 *   calendar → yea://127.0.0.1:7447   and  http://127.0.0.1:8447/yea
 *   shop     → yea://127.0.0.1:7449   and  http://127.0.0.1:8449/yea
 * Trusted principals come from YEA_TRUST (comma-separated "ed25519:…" keys).
 * YEA_PORT moves the calendar's yea:// port and the others with it. YEA_PORT=0
 * binds free ports; the line printed on stderr names the ports actually bound.
 */
import type { Server } from 'node:net';
import { listen, serveHttp } from '@yea-protocol/sdk/node';
import { calendar } from './calendar.ts';
import { shop } from './shop.ts';

const trust = (process.env.YEA_TRUST ?? '').split(',').filter(Boolean);
const host = process.env.HOST ?? '127.0.0.1';
const base = Number(process.env.YEA_PORT ?? 7447);
const cal = calendar({ trust });
const sh = shop({ trust });

/** The port `offset` above the base, or 0 (any free port) when the base is 0. */
const at = (offset: number) => (base === 0 ? 0 : base + offset);

/** The port a listening server is bound to. */
const bound = (server: Server) => {
  const a = server.address();

  return typeof a === 'object' && a ? a.port : 0;
};

const [calTcp, calHttp, shopTcp, shopHttp] = (
  await Promise.all([
    listen(cal, { port: at(0), host }),
    serveHttp(cal, { port: at(1000), host }),
    listen(sh, { port: at(2), host }),
    serveHttp(sh, { port: at(1002), host }),
  ])
).map(bound);

console.error(
  `yea examples up · calendar yea://${host}:${calTcp} http://${host}:${calHttp}/yea · shop yea://${host}:${shopTcp} http://${host}:${shopHttp}/yea · trusting ${trust.length} principal(s)`,
);
