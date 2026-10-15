/**
 * Consent: every COMMIT goes through the SDK's consent round (consent-check.ts). When the
 * service asks the human, the round checks its request against the proposal the agent received
 * and waits here; the card shows that proposal, and approving signs the consent the round built
 * from it, never the service's request, and lets the round commit once more.
 */
import type { Client, ConsentRequest } from '@yea-protocol/sdk';
import {
  type ComputedRef,
  computed,
  type Ref,
  ref,
  type ShallowRef,
  shallowRef,
} from 'vue';
import { factsLine, proposalFacts } from '../proposal-facts';
import {
  type ConsentCheck,
  checkOf,
  startRound,
  type Waiting,
} from './consent-check';
import type { Core, Exchange, Keys } from './model';
import type { ReceivedProposal } from './seen';

/** What the consent card shows about the proposal. */
export interface ConsentFacts {
  summary: string;
  effects: string[];
  meta: string;
}

interface ConsentDeps {
  core: ShallowRef<Core | null>;
  keys: ShallowRef<Keys | null>;
  log: Ref<Exchange[]>;
  current: ComputedRef<Exchange | null>;
  selected: Ref<number | null>;
}

/** A round at exchange `n`: where it stands, and the human's answer while it waits. */
interface Round {
  n: number;
  check: ConsentCheck;
  waiting?: Waiting;
}

const OVER: ConsentCheck = {
  state: 'refused',
  why: "it isn't waiting on you any more; commit the proposal again to be asked",
};

/** What the exchange on show asks: the service's consent request, and its own reason. */
function askedIn(current: ComputedRef<Exchange | null>) {
  const request = computed((): ConsentRequest | null => {
    const r = current.value?.reply;

    return r?.kind === 'ERROR' && r.code === 'consent_required'
      ? (r.consent ?? null)
      : null;
  });
  const message = computed(() => {
    const r = current.value?.reply;

    return r?.kind === 'ERROR' ? r.message : '';
  });

  return { request, message };
}

/** What the card shows for `here`, the round at the exchange on show. */
function cardFor(
  core: ShallowRef<Core | null>,
  here: ComputedRef<Round | null>,
  starting: Ref<boolean>,
) {
  const check = computed((): ConsentCheck => {
    if (here.value) {
      return here.value.check;
    }

    return starting.value ? { state: 'checking' } : OVER;
  });
  const facts = computed((): ConsentFacts | null => {
    const p = here.value?.waiting?.ask.proposal;
    const sdk = core.value;

    if (!p || !sdk) {
      return null;
    }

    const f = proposalFacts(sdk, p);

    return { summary: p.summary, effects: f.effects, meta: factsLine(f) };
  });

  return { check, facts };
}

export function useConsent({
  core,
  keys,
  log,
  current,
  selected,
}: ConsentDeps) {
  const round = shallowRef<Round | null>(null);
  const starting = ref(false);
  const here = computed(() =>
    round.value && round.value.n === current.value?.n ? round.value : null,
  );
  const { check, facts } = cardFor(core, here, starting);

  /** COMMIT `p` through the round; resolves once it waits on the human or ends. */
  async function commit(
    client: Client,
    p: ReceivedProposal,
    budget?: number,
  ): Promise<void> {
    const sdk = core.value;
    const k = keys.value;

    if (!sdk || !k) {
      return;
    }

    // A new COMMIT ends the round still waiting before it.
    round.value?.waiting?.decide(false);
    round.value = null;
    starting.value = true;

    try {
      const started = await startRound(sdk, {
        client,
        proposal: p,
        principal: k.principal,
        budget,
      });
      const shown = checkOf(started);
      const n = log.value[log.value.length - 1]?.n;

      if (shown && n !== undefined) {
        round.value = {
          n,
          check: shown,
          waiting: 'waiting' in started ? started.waiting : undefined,
        };
      }
    } finally {
      starting.value = false;
    }
  }

  /** The human approves: the round signs the consent it built and commits once more. */
  async function approve(): Promise<void> {
    const w = here.value?.waiting;

    if (!w) {
      return;
    }

    round.value = null;
    selected.value = null;
    w.decide(true);
    await w.done;
  }

  return { ...askedIn(current), facts, check, approve, commit };
}
