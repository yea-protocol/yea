/**
 * One run of a landing example on the real core: the person signs a policy for their agent,
 * the agent sends an intent to an example service and commits the first proposal, and the
 * commit either goes through inside the policy or waits on the person, who can approve that
 * exact proposal. Either way it can then be undone.
 *
 * The SDK and the service come in as arguments (loaded lazily in the page, from the build in
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

/** Makes an example service, trusting the given principal keys. */
export type ServiceFactory = (opts: { trust: string[] }) => Service;

/** The service's answer to an intent: its proposals, and the first, which the agent picks. */
export interface Proposed {
  params: Record<string, unknown>;
  proposalsLens: string;
  count: number;
  proposal: Proposal;
  hash: string;
}

/** A proposal the service won't commit without the person's consent. */
export interface Waiting {
  params: Record<string, unknown>;
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

/** How a commit was answered: it waits on the person, or it went through inside the policy. */
export type Answer =
  | { outcome: 'asks'; waiting: Waiting }
  | { outcome: 'within'; done: Done };

/** A reply that isn't the one the example expects, as a sentence a person can read. */
function failure(what: string, r: { kind: string; message?: string }) {
  const why =
    r.kind === 'ERROR' && r.message
      ? r.message
      : `the service replied ${r.kind}`;

  return new Error(`${what}: ${why}.`);
}

/** When a grant's `exp` caveat says it expires, in unix seconds (Infinity if never). */
const expiryOf = (caveats: Caveat[]) =>
  caveats.reduce(
    (t, c) => ('exp' in c ? Math.min(t, c.exp) : t),
    Number.POSITIVE_INFINITY,
  );

interface Parts {
  sdk: SessionSdk;
  keys: { principal: KeyPair; agent: KeyPair };
  client: Client;
  grant: string;
  grantExpires: number;
}

export class Session {
  private readonly sdk: SessionSdk;
  private readonly keys: Parts['keys'];
  private readonly client: Client;
  /** The policy grant the agent holds, and when it expires (unix seconds). */
  readonly grant: string;
  readonly grantExpires: number;

  private constructor(parts: Parts) {
    this.sdk = parts.sdk;
    this.keys = parts.keys;
    this.client = parts.client;
    this.grant = parts.grant;
    this.grantExpires = parts.grantExpires;
  }

  /** Sign the policy and start the service, with fresh keys. */
  static async start(sdk: SessionSdk, make: ServiceFactory, caveats: Caveat[]) {
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
      sdk.local(make({ trust: [principal.public] })),
      {
        key: agent.seed,
        grants: [grant],
        name: 'landing',
      },
    );

    return new Session({
      sdk,
      keys: { principal, agent },
      client,
      grant,
      grantExpires: expiryOf(caveats),
    });
  }

  /** The agent's INTENT: the service's proposals, and the first, which the agent picks. */
  async propose(
    capability: string,
    params: Record<string, unknown>,
  ): Promise<Proposed> {
    const r = await this.client.intent(capability, params);

    if (r.kind !== 'PROPOSALS') {
      throw failure("The service didn't propose anything", r);
    }

    const proposal = r.proposals[0];

    return {
      params,
      proposalsLens: r.lens,
      count: r.proposals.length,
      proposal,
      hash: await this.sdk.proposalHash(proposal),
    };
  }

  /** The agent's COMMIT: it goes through inside the policy, or the service asks the person. */
  async commit(p: Proposed): Promise<Answer> {
    const c = await this.client.commit(p.proposal);

    if (c.kind === 'RECEIPT') {
      return { outcome: 'within', done: { receipt: c.receipt, lens: c.lens } };
    }

    if (c.kind !== 'ERROR' || c.code !== 'consent_required' || !c.consent) {
      throw failure("The commit didn't go through", c);
    }

    // What the person signs must be the proposal the page shows.
    if (p.hash !== c.consent.hash) {
      throw new Error('the consent request does not match the proposal');
    }

    return {
      outcome: 'asks',
      waiting: {
        params: p.params,
        proposalsLens: p.proposalsLens,
        proposal: p.proposal,
        consent: c.consent,
        reason: c.message,
        consentLens: c.lens,
      },
    };
  }

  /** The person signs a one-time grant for this proposal's hash; the commit then goes through. */
  async approve(w: Waiting): Promise<Done & { consentGrant: string }> {
    // A consent for an expired proposal can't be accepted; say so rather than ask again.
    if (Date.now() / 1000 >= w.proposal.expires) {
      throw new Error(
        "It didn't go through: the proposal expired before it was approved.",
      );
    }

    const consentGrant = await this.sdk.consentGrant({
      principal: this.keys.principal,
      agent: this.keys.agent.public,
      consent: w.consent,
    });
    const r = await this.client.commit(w.proposal, { grants: [consentGrant] });

    if (r.kind !== 'RECEIPT') {
      throw failure("It didn't go through", r);
    }

    return { receipt: r.receipt, lens: r.lens, consentGrant };
  }

  async undo(receipt: string): Promise<Done> {
    const r = await this.client.undo(receipt);

    if (r.kind !== 'RECEIPT') {
      throw failure("The undo didn't go through", r);
    }

    return { receipt: r.receipt, lens: r.lens };
  }
}
