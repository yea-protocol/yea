/**
 * The demo's shop scenes: a menu search fitted to a token budget, then an order over the policy's
 * limit, committed through the consent round once the human signs a one-time consent.
 */
import {
  type Answer,
  type Client,
  consentRound,
  type Proposal,
  type RoundClient,
  signer,
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

/** Commit `pick` through the consent round, narrating each COMMIT it sends and the human's yes. */
async function commitWithConsent(
  n: Narrator,
  sh: Client,
  pick: Proposal,
  { james }: Keys,
) {
  n.say(n.agent, `commits [${pick.id}]:`);

  const events: string[] = [];
  const client: RoundClient = {
    key: sh.key,
    audience: () => sh.audience(),
    async commit(p, o) {
      const consent = Boolean(o?.grants?.length);

      n.wire(
        'COMMIT',
        consent
          ? `${p.id} + consent grant`
          : `${p.id} #${p.hash.slice(0, 10)}…`,
      );

      const r = await sh.commit(p, o);

      n.show([...events.splice(0), r.lens].join('\n'));

      return r;
    },
  };

  const out = await consentRound({
    client,
    proposal: pick,
    onEvent: (e) => events.push(e.lens),
    // The round has checked the service's request against `pick`; this signs the consent it built.
    approver: signer(james, async () => {
      n.say(
        n.human,
        `(simulated) gets a push notification, reads the exact effects and taps Approve. That signs a one-time consent for this proposal only (hash ${pick.hash.slice(0, 10)}…):`,
      );

      return true;
    }),
  });

  if (out.kind === 'refused') {
    n.say(n.agent, `doesn't ask the human: ${out.why}.`);
  }
}
