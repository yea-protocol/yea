/**
 * Serve the example services.
 *   calendar → yea://127.0.0.1:7447   and  http://127.0.0.1:8447/yea
 *   shop     → yea://127.0.0.1:7449   and  http://127.0.0.1:8449/yea
 * Trusted principals come from YEA_TRUST (comma-separated "ed25519:…" keys).
 */
import { listen, serveHttp } from '@yea-protocol/sdk/node';
import { calendar } from './calendar.ts';
import { shop } from './shop.ts';

const trust = (process.env.YEA_TRUST ?? '').split(',').filter(Boolean);
const host = process.env.HOST ?? '127.0.0.1';
const cal = calendar({ trust });
const sh = shop({ trust });

await Promise.all([
  listen(cal, { port: 7447, host }),
  serveHttp(cal, { port: 8447, host }),
  listen(sh, { port: 7449, host }),
  serveHttp(sh, { port: 8449, host }),
]);
console.error(
  `yea examples up · calendar yea://${host}:7447 http://${host}:8447/yea · shop yea://${host}:7449 http://${host}:8449/yea · trusting ${trust.length} principal(s)`,
);
