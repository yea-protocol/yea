/**
 * One run of the landing's example on the real core: the person signs a policy for their
 * agent, the agent asks the example shop for an order that goes over it, and the person can
 * approve that exact proposal, then undo it.
 *
 * The SDK and the shop come in as arguments (loaded lazily in the page, from the build in
 * the recording script), so this file has no runtime imports.
 */
import type {
  Caveat,
  Client,
  ConsentRequest,
  KeyPair,
  Proposal,
  Receipt,
  Service,
} from '@yea-protocol/sdk';

/** The SDK functions a session uses. */
export type SessionSdk = Pick<
  typeof import('@yea-protocol/sdk'),
  | 'Client'
  | 'consentGrant'
  | 'issueGrant'
  | 'keyPair'
  | 'local'
  | 'proposalHash'
>;

/** Makes the example shop, trusting the given principal keys. */
export type ShopFactory = (opts: { trust: string[] }) => Service;

/** The order the agent places: four meals, over a $40 limit. */
export const ORDER_ITEMS = [
  { sku: 'm047', qty: 2 },
  { sku: 'm055', qty: 2 },
];

/** A proposal the service won't commit without the person's consent. */
export interface Waiting {
  params: { items: typeof ORDER_ITEMS; deliver: string };
  proposalsLens: string;
  proposal: Proposal;
  consent: ConsentRequest;
  /** The service's reason, from its consent_required error. */
  reason: string;
  consentLens: string;
}

export interface Done {
  receipt: Receipt;
  lens: string;
}

/** What went wrong, when a reply isn't the one the example expects. */
const unexpected = (step: string, r: { kind: string; lens: string }) =>
  new Error(
    `${step}: expected otherwise, got ${r.kind}: ${r.lens.split('\n')[0]}`,
  );

interface Parts {
  sdk: SessionSdk;
  keys: { principal: KeyPair; agent: KeyPair };
  client: Client;
  grant: string;
}

export class Session {
  private readonly sdk: SessionSdk;
  private readonly keys: Parts['keys'];
  private readonly client: Client;
  /** The policy grant the agent holds. */
  readonly grant: string;

  private constructor(parts: Parts) {
    this.sdk = parts.sdk;
    this.keys = parts.keys;
    this.client = parts.client;
    this.grant = parts.grant;
  }

  /** Sign the policy and start the shop, with fresh keys. */
  static async start(sdk: SessionSdk, shop: ShopFactory, caveats: Caveat[]) {
    const [principal, agent] = await Promise.all([
      sdk.keyPair(),
      sdk.keyPair(),
    ]);
    const grant = await sdk.issueGrant({
      principal,
      to: agent.public,
      caveats,
    });
    const client = new sdk.Client(
      sdk.local(shop({ trust: [principal.public] })),
      {
        key: agent.seed,
        grants: [grant],
        name: 'landing',
      },
    );

    return new Session({ sdk, keys: { principal, agent }, client, grant });
  }

  /** The agent's INTENT and first COMMIT: a proposal over the policy, waiting on the person. */
  async propose(deliver: string): Promise<Waiting> {
    const params = { items: ORDER_ITEMS, deliver };
    const r = await this.client.intent('shop.order', params);

    if (r.kind !== 'PROPOSALS') {
      throw unexpected('INTENT', r);
    }

    const proposal = r.proposals[0];
    const c = await this.client.commit(proposal);

    if (c.kind !== 'ERROR' || c.code !== 'consent_required' || !c.consent) {
      throw unexpected('COMMIT', c);
    }

    // What the person signs must be the proposal the page shows.
    if ((await this.sdk.proposalHash(proposal)) !== c.consent.hash) {
      throw new Error('the consent request does not match the proposal');
    }

    return {
      params,
      proposalsLens: r.lens,
      proposal,
      consent: c.consent,
      reason: c.message,
      consentLens: c.lens,
    };
  }

  /** The person signs a one-time grant for this proposal's hash; the commit then goes through. */
  async approve(w: Waiting): Promise<Done & { consentGrant: string }> {
    const consentGrant = await this.sdk.consentGrant({
      principal: this.keys.principal,
      agent: this.keys.agent.public,
      consent: w.consent,
    });
    const r = await this.client.commit(w.proposal, { grants: [consentGrant] });

    if (r.kind !== 'RECEIPT') {
      throw unexpected('COMMIT', r);
    }

    return { receipt: r.receipt, lens: r.lens, consentGrant };
  }

  async undo(receipt: string): Promise<Done> {
    const r = await this.client.undo(receipt);

    if (r.kind !== 'RECEIPT') {
      throw unexpected('UNDO', r);
    }

    return { receipt: r.receipt, lens: r.lens };
  }
}

/** Tomorrow's date in UTC, as the shop's `deliver` param. */
export const tomorrow = (now = Date.now()) =>
  new Date(now + 864e5).toISOString().slice(0, 10);
