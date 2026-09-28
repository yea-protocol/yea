/**
 * The demo's shop scenes: a menu search fitted to a token budget, then an order over the policy's
 * limit, committed once the human signs a one-time consent.
 */
import {
  type Answer,
  type Client,
  consentGrant,
  type Proposal,
} from '../../index.js';
import type { Keys } from './grants.js';
import { day, type Narrator } from './narrator.js';

export async function browseMenu(n: Narrator, sh: Client) {
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

export async function order(n: Narrator, sh: Client, keys: Keys) {
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
