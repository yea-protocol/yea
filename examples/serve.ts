/**
 * Serve the example services.
 *   calendar → yea://127.0.0.1:7447   and  http://127.0.0.1:8447/yea
 *   shop     → yea://127.0.0.1:7449   and  http://127.0.0.1:8449/yea
 * Trusted principals come from YEA_TRUST (comma-separated "ed25519:…" keys).
 * YEA_PORT moves the calendar's yea:// port and the others with it. YEA_PORT=0
 * binds free ports; the line printed on stderr names the addresses bound.
 */
import type { Server } from 'node:net';
import { listen, serveHttp } from '@yea-protocol/sdk/node';
import { calendar } from './calendar.ts';
import { shop } from './shop.ts';

const trust = (process.env.YEA_TRUST ?? '').split(',').filter(Boolean);
const host = process.env.HOST ?? '127.0.0.1';
const base = Number(process.env.YEA_PORT || 7447);
const cal = calendar({ trust });
const sh = shop({ trust });

// The shop's HTTP port is base + 1002, so the base must leave room for it.
if (!Number.isInteger(base) || base < 0 || base > 65_535 - 1002) {
  console.error(
    `YEA_PORT must be a whole number from 0 to ${65_535 - 1002} (0 binds free ports), not ${JSON.stringify(process.env.YEA_PORT)}`,
  );
  process.exit(2);
}

/** The port `offset` above the base, or 0 (any free port) when the base is 0. */
const at = (offset: number) => (base === 0 ? 0 : base + offset);

/** The `host:port` a listening server is bound to (`localhost` names one address). */
const bound = (server: Server) => {
  const a = server.address();

  if (typeof a !== 'object' || !a) {
    throw new Error('server is not listening on TCP');
  }

  return a.family === 'IPv6'
    ? `[${a.address}]:${a.port}`
    : `${a.address}:${a.port}`;
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
  `yea examples up · calendar yea://${calTcp} http://${calHttp}/yea · shop yea://${shopTcp} http://${shopHttp}/yea · trusting ${trust.length} principal(s)`,
);
