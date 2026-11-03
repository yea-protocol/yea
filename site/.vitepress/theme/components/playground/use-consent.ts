/**
 * Consent: every COMMIT goes through the SDK's consent round (consent-check.ts). When the
 * service asks the human, the round checks its request against the proposal the agent received
 * and waits here; the card shows that proposal, and approving signs the consent the round built
 * from it, never the service's request, and lets the round commit once more. Declining signs
 * nothing and ends the round with no second COMMIT; the proposal is left to expire, and the
 * card and the history say the exchange was declined.
 *
 * Its runtime imports name their `.ts` files, so the tests can run it under Node.
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
import { factsLine, proposalFacts } from '../proposal-facts.ts';
import {
  type ConsentCheck,
  checkOf,
  startRound,
  type Waiting,
} from './consent-check.ts';
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

/** An exchange a round ran, whose round has ended. */
const OVER: ConsentCheck = {
  state: 'refused',
  why: "it isn't waiting on you any more; commit the proposal again to be asked",
};

/** An exchange no round ran: a COMMIT of a proposal auto-committed or got from another service. */
const NO_ROUND: ConsentCheck = {
  state: 'refused',
  why: 'the playground asks you only when the agent commits a proposal it received from this service, and this COMMIT was not one',
};

/** The exchanges the consent round sent, and how to note the latest one. */
function roundExchanges(log: Ref<Exchange[]>) {
  const ran = shallowRef<ReadonlySet<number>>(new Set());

  /** Note the latest exchange as the round's; its number, if there is one. */
  function mark(): number | undefined {
    const n = log.value[log.value.length - 1]?.n;

    if (n !== undefined) {
      ran.value = new Set([...ran.value, n]);
    }

    return n;
  }

  return { ran, mark };
}

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
function cardFor(o: {
  core: ShallowRef<Core | null>;
  current: ComputedRef<Exchange | null>;
  here: ComputedRef<Round | null>;
  starting: Ref<boolean>;
  ran: Ref<ReadonlySet<number>>;
  declined: Ref<Declined>;
}) {
  const { core, here } = o;
  const check = computed((): ConsentCheck => {
    if (here.value) {
      return here.value.check;
    }

    const expires = o.declined.value.get(o.current.value?.n ?? -1);

    if (expires !== undefined) {
      return { state: 'declined', expires };
    }

    if (o.starting.value) {
      return { state: 'checking' };
    }

    return o.ran.value.has(o.current.value?.n ?? -1) ? OVER : NO_ROUND;
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

/**
 * Approve the round `r`: it signs the consent it built and commits once more, and `mark` notes
 * that COMMIT as the round's. The reply pane follows to it.
 */
async function approveRound(
  round: ShallowRef<Round | null>,
  r: Round | null,
  selected: Ref<number | null>,
  mark: () => void,
): Promise<void> {
  const w = r?.waiting;

  if (!w) {
    return;
  }

  round.value = null;
  selected.value = null;
  w.decide(true);
  await w.done;
  mark();
}

/** The exchanges the human declined, each with when its proposal expires (unix seconds). */
export type Declined = ReadonlyMap<number, number>;

/** End the round `r` with a no: nothing is signed, and its exchange is kept as declined. */
async function declineRound(
  round: ShallowRef<Round | null>,
  r: Round | null,
  declined: ShallowRef<Declined>,
): Promise<void> {
  const w = r?.waiting;

  if (!r || !w) {
    return;
  }

  declined.value = new Map([...declined.value, [r.n, w.ask.proposal.expires]]);
  round.value = null;
  w.decide(false);
  await w.done;
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
  const { ran, mark } = roundExchanges(log);
  const declined = shallowRef<Declined>(new Map());
  const { check, facts } = cardFor({
    core,
    current,
    here,
    starting,
    ran,
    declined,
  });

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
      const n = mark();

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
  const approve = () => approveRound(round, here.value, selected, mark);

  /** The human declines: nothing is signed, and the card says when the proposal expires. */
  const decline = () => declineRound(round, here.value, declined);

  return {
    ...askedIn(current),
    facts,
    check,
    declined,
    approve,
    decline,
    commit,
  };
}
