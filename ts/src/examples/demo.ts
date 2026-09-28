/**
 * A narrated, end-to-end YEA session over real TCP.  Run:  npm run demo
 * A human (the principal) delegates to an agent with a policy; the agent does real work
 * against two services; one purchase exceeds the policy and needs the human's consent.
 *
 * This file is the flow: it starts both services and runs the scenes in order. The scenes are
 * in demo/: grants.ts (delegating, and a sub-agent), reschedule.ts (the calendar) and
 * shopping.ts (the shop), told by narrator.ts.
 */
import type { AddressInfo, Server } from 'node:net';
import { keyPair } from '../index.js';
import { connect, listen } from '../node.js';
import { calendar } from './calendar.js';
import { delegate, type Keys, subAgent } from './demo/grants.js';
import { ANSI, narrator } from './demo/narrator.js';
import { reschedule } from './demo/reschedule.js';
import { browseMenu, order } from './demo/shopping.js';
import { shop } from './shop.js';

const url = (srv: Server) =>
  `yea://127.0.0.1:${(srv.address() as AddressInfo).port}`;

/** Run the narrated end-to-end demo over real TCP sockets (`yea demo`). */
export async function runDemo(): Promise<void> {
  const n = narrator();

  // ── setup: two services on real sockets ──────────────────────────────────────
  const keys: Keys = {
    james: await keyPair(),
    agent: await keyPair(),
    helper: await keyPair(),
  };
  const trust = [keys.james.public];
  const calSrv = await listen(calendar({ trust }), { port: 0 });
  const shopSrv = await listen(shop({ trust }), { port: 0 });

  console.log(
    n.k(
      '\nYEA demo — agents propose, humans set policy, everything is undoable\n',
      ANSI.b,
    ),
  );

  const policy = await delegate(n, keys);
  const agentOpts = {
    key: keys.agent.seed,
    grants: [policy],
    name: 'demo-agent',
  };
  const cal = await connect(url(calSrv), agentOpts);
  const sh = await connect(url(shopSrv), agentOpts);

  await reschedule(n, cal, url(calSrv));
  await browseMenu(n, sh);
  await order(n, sh, keys);

  const sub = await subAgent(n, policy, keys, url(shopSrv));

  console.log(
    n.k(
      `\n✔ done. Every reply above is exactly what a model would read.\n`,
      ANSI.grn,
    ),
  );

  for (const x of [cal, sh, sub]) {
    x.close();
  }

  calSrv.close();
  shopSrv.close();
}
