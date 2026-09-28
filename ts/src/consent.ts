/**
 * Consent (SPEC §6.6): the one-shot grant that approves one exact proposal, and the `pc1.`
 * code that carries a consent request to a person to approve out of band.
 */
import { b64u, fromUtf8, unb64u, utf8 } from './b64.js';
import { canonical } from './canonical.js';
import type { KeyPair } from './crypto.js';
import { isPublicKey, issueGrant } from './grants.js';
import type { ConsentRequest, Proposal } from './types.js';

/**
 * Consent grant (SPEC §6.6): one-shot approval of one exact proposal. It is scoped to COMMIT
 * of that proposal's capability at that service, so it authorizes nothing else.
 */
export function consentGrant(opts: {
  principal: KeyPair | string;
  agent: string;
  consent: Pick<ConsentRequest, 'service' | 'capability' | 'hash' | 'expires'>;
}): Promise<string> {
  const c = opts.consent;

  return issueGrant({
    principal: opts.principal,
    to: opts.agent,
    caveats: [
      { svc: [c.service] },
      { verbs: ['COMMIT'] },
      { can: [c.capability] },
      { only: c.hash },
      { exp: c.expires },
    ],
  });
}

/**
 * A consent request packed for a human to approve out of band (`yea approve <code>`).
 * `detail` carries the full proposal (as the agent saw it) so the approver can show its
 * effects and re-check the hash, instead of trusting a service-written summary. `agent` is the
 * key the consent should be issued to, for approving on a machine without that agent's key; it
 * is unsigned, so `yea approve` shows it and checks it against a local agent key.
 */
export function consentCode(
  c: ConsentRequest,
  detail?: Omit<Proposal, 'data'>,
  o: { agent?: string } = {},
): string {
  const { data: _d, ...d } = (detail ?? {}) as Proposal;
  const body = {
    ...c,
    ...(detail ? { detail: d } : {}),
    ...(o.agent === undefined ? {} : { agent: o.agent }),
  };

  return encodeConsentCode(body);
}

/**
 * Who `yea approve` issues a protocol consent to: `--to` if given, else this machine's agent key
 * when the code names it or no one. The code's `agent` is unsigned, so it's never used on its
 * own: a code naming another key, or one on a machine without an agent key, needs `--to`.
 * Returns the key, or why there is none.
 */
export function consentRecipient(o: {
  code: unknown;
  local: string | null;
  to?: string;
}): { key: string } | { why: string } {
  const named = o.code === undefined || isPublicKey(o.code) ? o.code : null;

  if (named === null) {
    return { why: 'the code names an agent key that is not an ed25519 key' };
  }

  if (o.to !== undefined) {
    return isPublicKey(o.to)
      ? { key: o.to }
      : { why: '--to is not an ed25519 public key' };
  }

  if (!o.local) {
    return {
      why: 'no agent key on this machine: pass --to <key> to say which agent the consent is for',
    };
  }

  return named === undefined || named === o.local
    ? { key: o.local }
    : {
        why: `the code asks for a consent to agent ${named}, but this machine's agent key is ${o.local}; pass --to <key> to say which`,
      };
}

const CONSENT_PREFIX = 'pc1.';

/** A consent request, with whatever rides along (`detail`, `agent`), as a `pc1.` code. */
export const encodeConsentCode = (
  body: ConsentRequest & { detail?: unknown; agent?: unknown },
) => CONSENT_PREFIX + b64u(utf8(canonical(body)));

export function decodeConsentCode(
  code: string,
): ConsentRequest & { detail?: Proposal; agent?: unknown } {
  if (!code.startsWith(CONSENT_PREFIX)) {
    throw new Error('not a consent code (expected pc1.…)');
  }

  const c = JSON.parse(fromUtf8(unb64u(code.slice(CONSENT_PREFIX.length))));

  for (const k of [
    'proposal',
    'hash',
    'service',
    'capability',
    'principal',
    'summary',
  ]) {
    if (typeof c[k] !== 'string') {
      throw new Error(`consent code missing ${k}`);
    }
  }

  if (!Number.isSafeInteger(c.expires)) {
    throw new Error('consent code missing expires');
  }

  return c;
}
