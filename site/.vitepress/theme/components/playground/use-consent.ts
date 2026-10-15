/**
 * Consent: when a reply asks the human to approve, find the proposal the agent committed,
 * check the request against it with the SDK's `consentToSign` (proposal, hash, capability,
 * service, and the proposal itself), describe it, and on approval sign the consent built from
 * that proposal, never the service's request, and commit with it.
 */
import type { ConsentRequest } from '@yea-protocol/sdk';
import { type ComputedRef, computed, ref, type ShallowRef, watch } from 'vue';
import { factsLine, proposalFacts } from '../proposal-facts';
import {
  type Core,
  type Exchange,
  type Keys,
  SERVICES,
  type ServiceKey,
} from './model';
import { type ReceivedProposal, receivedProposal, type Seen } from './seen';
import type { useShortcuts } from './use-shortcuts';

type Act = ReturnType<typeof useShortcuts>['act'];

/** Where the check stands: what to sign once it passes, or why it can't be approved. */
export type ConsentCheck =
  | { state: 'checking' }
  | { state: 'ok'; consent: ConsentRequest }
  | { state: 'refused'; why: string };

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
  act: Act;
}

/** The proposal the exchange committed: the one the agent received, at that service. */
function committedProposal(seen: Seen, x: Exchange): ReceivedProposal | null {
  if (x.request.verb !== 'COMMIT') {
    return null;
  }

  const p = receivedProposal(seen, x.request.proposal, x.request.hash);

  return p?.service === x.service ? p : null;
}

/** Check request `c` against `p`, the proposal shown, at the service that sent it. */
async function checkAgainst(
  sdk: Core,
  c: ConsentRequest,
  p: ReceivedProposal,
  service: ServiceKey,
): Promise<ConsentCheck> {
  const { service: _s, committed: _c, ...proposal } = p;
  const r = await sdk.consentToSign(c, proposal, SERVICES[service]);

  return 'why' in r
    ? { state: 'refused', why: r.why }
    : { state: 'ok', consent: r.consent };
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
    const x = current.value;

    return x ? committedProposal(seen, x) : null;
  });
  const check = ref<ConsentCheck>({ state: 'checking' });
  const facts = computed((): ConsentFacts | null => {
    const p = proposal.value;
    const sdk = core.value;

    if (!p || !sdk) {
      return null;
    }

    const f = proposalFacts(sdk, p);

    return { summary: p.summary, effects: f.effects, meta: factsLine(f) };
  });

  watch(request, async (c, _old, onCleanup) => {
    // A newer request replaces this one: drop this check's result when it lands.
    let stale = false;

    onCleanup(() => {
      stale = true;
    });
    check.value = { state: 'checking' };

    const p = proposal.value;
    const sdk = core.value;
    const x = current.value;

    if (!c || !p || !sdk || !x) {
      check.value = {
        state: 'refused',
        why: "the agent didn't commit a proposal it received from this service",
      };

      return;
    }

    const checked = await checkAgainst(sdk, c, p, x.service);

    if (!stale) {
      check.value = checked;
    }
  });

  /** Sign the consent built from the shown proposal as the human, then commit with it. */
  async function approve(): Promise<void> {
    const ok = check.value;
    const k = keys.value;
    const sdk = core.value;

    if (ok.state !== 'ok' || !k || !sdk) {
      return;
    }

    const token = await sdk.consentGrant({
      principal: k.principal,
      agent: k.agent.public,
      consent: ok.consent,
    });
    const service = current.value?.service;

    if (service) {
      await act('COMMIT', ok.consent.proposal, service, [token]);
    }
  }

  return { request, message, facts, check, approve };
}
