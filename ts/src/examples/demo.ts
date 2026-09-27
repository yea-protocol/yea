// A narrated, end-to-end YEA session over real TCP.  Run:  npm run demo
// A human (the principal) delegates to an agent with a policy; the agent does real work
// against two services; one purchase exceeds the policy and needs the human's consent.
import type { AddressInfo, Server } from 'node:net';
import {
  type Answer,
  type Client,
  consentGrant,
  delegateGrant,
  est,
  issueGrant,
  type KeyPair,
  keyPair,
  type Proposal,
} from '../index.js';
import { connect, listen } from '../node.js';
import { calendar } from './calendar.js';
import { shop } from './shop.js';

const ANSI = {
  dim: '\x1b[2m',
  b: '\x1b[1m',
  cyan: '\x1b[36m',
  mag: '\x1b[35m',
  yel: '\x1b[33m',
  grn: '\x1b[32m',
  red: '\x1b[31m',
  x: '\x1b[0m',
};

const day = (n: number) =>
  new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
const url = (srv: Server) =>
  `yea://127.0.0.1:${(srv.address() as AddressInfo).port}`;

interface Keys {
  james: KeyPair;
  agent: KeyPair;
  helper: KeyPair;
}

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

function narrator() {
  const color =
    (process.stdout.isTTY || !!process.env.FORCE_COLOR) &&
    !process.env.NO_COLOR;
  const k = (s: string, code: string) => (color ? code + s + ANSI.x : s);
  let step = 0;

  return {
    k,
    human: k('👤 human', ANSI.yel),
    agent: k('🤖 agent', ANSI.mag),
    sub: k('🤖 sub-agent', ANSI.mag),
    say(who: string, text: string) {
      step += 1;
      console.log(`\n${k(`${step}.`, ANSI.dim)} ${k(who, ANSI.b)} ${text}`);
    },
    wire(verb: string, detail: string) {
      console.log(k(`   → ${verb}`, ANSI.cyan) + k(` ${detail}`, ANSI.dim));
    },
    show(text: string) {
      console.log(
        text
          .split('\n')
          .map((l) => `   ${k('│ ', ANSI.dim)}${l}`)
          .join('\n'),
      );
      console.log(k(`   └ ${est(text)} tokens`, ANSI.dim));
    },
  };
}

type Narrator = ReturnType<typeof narrator>;

async function delegate(n: Narrator, { james, agent }: Keys) {
  n.say(n.human, 'delegates to the agent with a policy, not a password:');

  const policy = await issueGrant({
    principal: james,
    to: agent.public,
    caveats: [
      { svc: ['calendar.example', 'shop.example'] },
      { risk: 'low' },
      { each: { of: 'spend', max: 4000, scale: 2, unit: 'USD' } },
      { total: { of: 'spend', max: 10000, scale: 2, unit: 'USD' } },
      { exp: Math.floor(Date.now() / 1000) + 8 * 3600 },
    ],
  });

  n.show(
    `grant ${policy.slice(0, 28)}… (${policy.length} bytes, signed Ed25519)\n  services: calendar.example, shop.example\n  risk ≤ low · ≤ 40.00 USD per action · ≤ 100.00 USD total · expires in 8h`,
  );

  return policy;
}

async function reschedule(n: Narrator, cal: Client, calUrl: string) {
  n.say(n.agent, 'discovers what the calendar can do:');
  n.wire('HELLO', calUrl);
  n.show((await cal.hello()).lens);

  n.say(
    n.agent,
    `"move my 1:1 with Ana to ${day(3)}", said with intent instead of CRUD calls:`,
  );
  n.wire('INTENT', `calendar.reschedule {event:"Ana", day:"${day(3)}"} auto`);

  const q = await cal.intent(
    'calendar.reschedule',
    { event: 'Ana', day: day(3) },
    { auto: true },
  );

  n.show(q.lens);

  if (q.kind !== 'CLARIFY') {
    return;
  }

  n.say(
    n.agent,
    "picks option 1. The service knows it's low-risk and undoable, and the policy allows that, so it commits in the same round trip:",
  );
  n.wire(
    'INTENT',
    `calendar.reschedule ${JSON.stringify({ ...q.options[0].params, day: day(3) })} auto`,
  );

  const r = await cal.intent(
    'calendar.reschedule',
    { event: 'Ana', day: day(3), ...q.options[0].params },
    { auto: true },
  );

  n.show(r.lens);

  if (r.kind !== 'RECEIPT') {
    return;
  }

  n.say(n.human, `(simulated) "wait, not that day." The agent undoes it:`);
  n.wire('UNDO', r.receipt.id);
  n.show((await cal.undo(r.receipt.id)).lens);
}

async function browseMenu(n: Narrator, sh: Client) {
  n.say(
    n.agent,
    'searches the 60-item menu for vegan meals with a 250-token budget; the rest waits behind a handle:',
  );
  n.wire('ASK', `shop.search {tag:"vegan"} budget=250`);

  const menu = (await sh.ask(
    'shop.search',
    { tag: 'vegan' },
    { budget: 250 },
  )) as Answer & { lens: string };

  n.show(menu.lens);

  if (menu.more?.[0]) {
    n.wire('EXPAND', `${menu.more[0].handle} budget=200`);
    n.show((await sh.expand(menu.more[0].handle, { budget: 200 })).lens);
  }
}

async function order(n: Narrator, sh: Client, keys: Keys) {
  n.say(
    n.agent,
    `orders 4 meals. It's over the 40.00 USD per-action limit, so no auto-commit, just proposals:`,
  );
  n.wire(
    'INTENT',
    `shop.order {items:[m005×2, m007×2], deliver:"${day(2)}"} auto`,
  );

  const reply = await sh.intent(
    'shop.order',
    {
      items: [
        { sku: 'm005', qty: 2 },
        { sku: 'm007', qty: 2 },
      ],
      deliver: day(2),
    },
    { auto: true },
  );

  n.show(reply.lens);

  if (reply.kind === 'PROPOSALS') {
    await commitWithConsent(n, sh, reply.proposals[0], keys);
  }
}

async function commitWithConsent(
  n: Narrator,
  sh: Client,
  pick: Proposal,
  { james, agent }: Keys,
) {
  n.say(n.agent, `commits [${pick.id}]:`);
  n.wire('COMMIT', `${pick.id} #${pick.hash.slice(0, 10)}…`);

  const denied = await sh.commit(pick);

  n.show(denied.lens);

  if (denied.kind !== 'ERROR' || !denied.consent) {
    return;
  }

  n.say(
    n.human,
    `(simulated) gets a push notification, reads the exact effects and taps Approve. That signs a one-time consent for this proposal only (hash ${pick.hash.slice(0, 10)}…):`,
  );

  const consent = await consentGrant({
    principal: james,
    agent: agent.public,
    consent: denied.consent,
  });

  n.wire('COMMIT', `${pick.id} + consent grant`);

  const events: string[] = [];
  const ok = await sh.commit(pick, {
    grants: [consent],
    onEvent: (e) => events.push(e.lens),
  });

  n.show([...events, ok.lens].join('\n'));
}

async function subAgent(
  n: Narrator,
  policy: string,
  { agent, helper }: Keys,
  shopUrl: string,
) {
  n.say(
    n.agent,
    'hands a sub-agent a narrower, read-only slice of its authority, offline and without asking the service:',
  );

  const narrowed = await delegateGrant(policy, {
    holder: agent,
    to: helper.public,
    caveats: [
      { verbs: ['HELLO', 'ASK', 'INTENT'] },
      { can: ['shop.search', 'shop.order'] },
    ],
  });
  const sub = await connect(shopUrl, {
    key: helper.seed,
    grants: [narrowed],
    name: 'sub-agent',
  });

  n.say(n.sub, 'tries to place an order anyway:');

  const sp = await sub.intent('shop.order', {
    items: [{ sku: 'm001', qty: 1 }],
    deliver: day(2),
  });

  if (sp.kind === 'PROPOSALS') {
    n.wire('COMMIT', sp.proposals[0].id);
    n.show((await sub.commit(sp.proposals[0])).lens);
  }

  return sub;
}
