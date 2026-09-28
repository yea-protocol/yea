/**
 * The demo's grants: the human delegates a policy to the agent, and the agent hands a sub-agent
 * a narrower, read-only slice of it, which the shop then refuses to commit on.
 */
import {
  delegateGrant,
  issueGrant,
  type KeyPair,
  unixNow,
} from '../../index.js';
import { connect } from '../../node.js';
import { day, type Narrator } from './narrator.js';

export interface Keys {
  james: KeyPair;
  agent: KeyPair;
  helper: KeyPair;
}

export async function delegate(n: Narrator, { james, agent }: Keys) {
  n.say(n.human, 'delegates to the agent with a policy, not a password:');

  const policy = await issueGrant({
    principal: james,
    to: agent.public,
    caveats: [
      { svc: ['calendar.example', 'shop.example'] },
      { risk: 'low' },
      { each: { of: 'spend', max: 4000, scale: 2, unit: 'USD' } },
      { total: { of: 'spend', max: 10000, scale: 2, unit: 'USD' } },
      { exp: unixNow() + 8 * 3600 },
    ],
  });

  n.show(
    `grant ${policy.slice(0, 28)}… (${policy.length} bytes, signed Ed25519)\n  services: calendar.example, shop.example\n  risk ≤ low · ≤ 40.00 USD per action · ≤ 100.00 USD total · expires in 8h`,
  );

  return policy;
}

export async function subAgent(
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
