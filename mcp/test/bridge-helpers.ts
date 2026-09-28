/**
 * Harness for the bridge (SPEC-bridge, Testing): the example calendar and shop served
 * in-process, an agent with a grant from a principal, a temp YEA home for consents, and what
 * `yea approve` does with a protocol consent code, without the terminal.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Caveat,
  Client,
  consentGrant,
  consentRecipient,
  decodeConsentCode,
  type FinalReply,
  issueGrant,
  type KeyPair,
  keyPair,
  local,
  type Request,
  type Service,
  type Transport,
} from '@yea-protocol/sdk';
import { calendar, shop } from '@yea-protocol/sdk/examples';
import { type BridgeOptions, bridge } from '../src/bridge.js';
import { connect, type Kind } from './helpers.js';

export const nowS = () => Math.floor(Date.now() / 1000);

/** A spending limit per commit: 40.00 USD. */
export const EACH_40: Caveat = {
  each: { of: 'spend', max: 4000, scale: 2, unit: 'USD' },
};

export interface Keys {
  home: string;
  principal: KeyPair;
  agent: KeyPair;
}

/** A fresh YEA home (consents are kept there), a principal and an agent. */
export async function keys(): Promise<Keys> {
  const home = mkdtempSync(join(tmpdir(), 'yea-bridge-'));

  process.env.YEA_HOME = home;
  delete process.env.YEA_PRINCIPAL_HOME;

  return { home, principal: await keyPair(), agent: await keyPair() };
}

/** Write `~/.yea/policy.json` (the unsigned tightening) in the test home. */
export const writePolicy = (k: Keys, policy: unknown) =>
  writeFileSync(join(k.home, 'policy.json'), JSON.stringify(policy));

/** A transport to `svc` that records every request, and lets a test rewrite replies. */
export function recorded(
  svc: Service,
  rewrite?: (f: Request, r: FinalReply) => FinalReply | Promise<FinalReply>,
) {
  const sent: Request[] = [];
  const inner = local(svc);
  const t: Transport = {
    async request(frame, onEvent) {
      sent.push(frame);

      const r = await inner.request(frame, onEvent);

      return rewrite ? rewrite(JSON.parse(JSON.stringify(frame)), r) : r;
    },
    close() {
      // in-process: nothing to release
    },
  };

  return { t, sent, verbs: (v: string) => sent.filter((f) => f.verb === v) };
}

/** The agent's client for a transport, with a grant from the principal (none if `caveats` is null). */
export async function agentClient(
  k: Keys,
  t: Transport,
  caveats: Caveat[] | null = [EACH_40],
) {
  return new Client(t, {
    key: k.agent.seed,
    grants: caveats
      ? [
          await issueGrant({
            principal: k.principal,
            to: k.agent.public,
            caveats,
          }),
        ]
      : [],
  });
}

/** The two example services as the bridge sees them, recorded. */
export async function examples(
  k: Keys,
  o: { caveats?: Caveat[] | null; shopId?: string } = {},
) {
  const trust = [k.principal.public];
  const cal = recorded(calendar({ trust }));
  const sh = recorded(shop({ trust, ...(o.shopId ? { id: o.shopId } : {}) }));
  const caveats = o.caveats === undefined ? [EACH_40] : o.caveats;

  return {
    cal,
    shop: sh,
    clients: [
      { client: await agentClient(k, cal.t, caveats), url: 'test:calendar' },
      { client: await agentClient(k, sh.t, caveats), url: 'test:shop' },
    ],
  };
}

/** Connect an MCP client of `kind` to a bridge over the example services. */
export async function bridged(
  k: Keys,
  kind: Kind = '2026',
  o: { caveats?: Caveat[] | null; options?: BridgeOptions } = {},
) {
  const ex = await examples(k, { caveats: o.caveats });
  const factory = await bridge(ex.clients, o.options);
  const conn = await connect(kind, factory);

  return { ...ex, factory, conn };
}

/**
 * What `yea approve <code>` does for a protocol code on a machine with the principal key and no
 * agent key: check the code's `agent`, then sign a one-time consent to it.
 */
export async function approveCode(principal: KeyPair, code: string) {
  const c = decodeConsentCode(code);
  const to = consentRecipient({ code: c.agent, local: null });

  if ('why' in to) {
    throw new Error(to.why);
  }

  if (c.principal !== principal.public) {
    throw new Error('this code is for another principal');
  }

  return consentGrant({ principal, agent: to.key, consent: c });
}

/** The structured proposals and codes of a job result. */
export const proposalsOf = (r: { structuredContent?: unknown }) =>
  (r.structuredContent ?? {}) as {
    proposals: { id: string; hash: string; summary: string; expires: number }[];
    codes: { proposal: string; code: string }[];
  };

/** An order over the 40 USD grant: four meals, about 50 USD with delivery. */
export const BIG_ORDER = {
  items: [{ sku: 'm001', qty: 4 }],
  deliver: '2030-01-01',
};

/** An order under the grant: one meal, about 17 USD. */
export const SMALL_ORDER = {
  items: [{ sku: 'm001', qty: 1 }],
  deliver: '2030-01-01',
};
