/**
 * Consent: when a reply asks the human to approve, find the proposal the agent received,
 * check that the request matches it (service, capability, hash), describe it, and on approval
 * sign a one-time consent grant and commit with it.
 */
import type { ConsentRequest } from '@yea-protocol/sdk';
import { type ComputedRef, computed, ref, type ShallowRef, watch } from 'vue';
import {
  type Core,
  type Exchange,
  type Keys,
  SERVICES,
  type ServiceKey,
  type TargetVerb,
} from './model';
import { type ReceivedProposal, receivedProposal, type Seen } from './seen';

export type ConsentCheck = 'checking' | 'ok' | 'mismatch';

/** What the consent card shows about the proposal. */
export interface ConsentFacts {
  summary: string;
  effects: string[];
  meta: string;
}

interface ConsentDeps {
  core: ShallowRef<Core | null>;
  keys: ShallowRef<Keys | null>;
  current: ComputedRef<Exchange | null>;
  seen: Seen;
  act: (
    verb: TargetVerb,
    target: string,
    service: ServiceKey,
    grants?: string[],
  ) => Promise<void>;
}

type Fmt = Pick<Core, 'fmtQuantity' | 'fmtDuration'>;

/** The card's facts line: what the proposal uses (if anything), its risk and its undo window. */
function consentMeta(fmt: Fmt, p: ReceivedProposal): string {
  const uses = p.uses ?? {};
  const used = Object.keys(uses)
    .sort()
    .map((n) => `${n} ${fmt.fmtQuantity(uses[n])}`);
  const parts = [
    ...(used.length ? [`uses ${used.join(', ')}`] : []),
    `risk ${p.risk}`,
    p.undo ? `undo for ${fmt.fmtDuration(p.undo.window)}` : 'irreversible',
  ];
  const text = parts.join(', ');

  return text[0].toUpperCase() + text.slice(1);
}

/** Whether the consent request names exactly this proposal, at the service that sent it. */
async function matches(
  sdk: Core,
  c: ConsentRequest,
  p: ReceivedProposal,
  service: ServiceKey,
): Promise<boolean> {
  const { service: _s, committed: _c, ...proposal } = p;

  return (
    c.service === SERVICES[service] &&
    c.capability === p.capability &&
    (await sdk.proposalHash(proposal)) === c.hash
  );
}

export function useConsent({ core, keys, current, seen, act }: ConsentDeps) {
  const request = computed((): ConsentRequest | null => {
    const r = current.value?.reply;

    return r?.kind === 'ERROR' && r.code === 'consent_required'
      ? (r.consent ?? null)
      : null;
  });
  /** The reply's own explanation of why it needs the human. */
  const message = computed(() => {
    const r = current.value?.reply;

    return r?.kind === 'ERROR' ? r.message : '';
  });
  const proposal = computed(() => {
    const c = request.value;

    return c ? receivedProposal(seen, c.proposal, c.hash) : null;
  });
  const check = ref<ConsentCheck>('checking');
  const facts = computed((): ConsentFacts | null => {
    const p = proposal.value;
    const sdk = core.value;

    if (!p || !sdk) {
      return null;
    }

    return {
      summary: p.summary,
      effects: p.effects.map((e) => sdk.effectLine(e)),
      meta: consentMeta(sdk, p),
    };
  });

  watch(request, async (c) => {
    check.value = 'checking';

    const p = proposal.value;
    const sdk = core.value;
    const x = current.value;

    if (!c || !p || !sdk || !x) {
      check.value = 'mismatch';

      return;
    }

    check.value = (await matches(sdk, c, p, x.service)) ? 'ok' : 'mismatch';
  });

  /** Sign a consent grant for exactly this proposal as the human, then commit with it. */
  async function approve(): Promise<void> {
    const c = request.value;
    const k = keys.value;
    const sdk = core.value;

    if (!c || check.value !== 'ok' || !k || !sdk) {
      return;
    }

    const token = await sdk.consentGrant({
      principal: k.principal,
      agent: k.agent.public,
      consent: c,
    });
    const service = current.value?.service;

    if (service) {
      await act('COMMIT', c.proposal, service, [token]);
    }
  }

  return { request, message, facts, check, approve };
}
