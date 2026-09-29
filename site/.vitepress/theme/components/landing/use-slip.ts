/**
 * The hero slip's state: it starts from the recorded exchange (so the page paints without
 * JavaScript), loads the real core when the browser is idle, and swaps in a live proposal
 * the visitor can approve, then undo. Once live it can always start again, and it says when
 * the proposal, the undo window or the example policy has run out instead of failing.
 */
import {
  onMounted,
  type Ref,
  ref,
  type ShallowRef,
  shallowRef,
  watch,
} from 'vue';
import { RECORDED } from './exchange';
import { type Lapse, lapsed, lapseText } from './expiry';
import { landingCaveats } from './policy';
import { Session, tomorrow, type Waiting } from './session';
import {
  type ReceiptView,
  receiptView,
  type SlipKit,
  type SlipView,
  slipView,
  type UndoneView,
  undoneView,
  utcClock,
} from './slip-view';

/**
 * `loading` until the core is live (or while a new proposal is fetched); `unavailable` if the
 * core couldn't start at all; `expired` when something ran out; `error` when a step failed.
 */
export type Phase =
  | 'loading'
  | 'unavailable'
  | 'waiting'
  | 'approving'
  | 'committed'
  | 'undoing'
  | 'undone'
  | 'expired'
  | 'error';

/** What the slip shows. */
interface SlipState {
  phase: Ref<Phase>;
  /** Whether the core is running; false while the recording is on show. */
  live: Ref<boolean>;
  slip: ShallowRef<SlipView>;
  receipt: ShallowRef<ReceiptView | null>;
  undone: ShallowRef<UndoneView | null>;
  /** The live region's one line: empty until the visitor acts. */
  status: Ref<string>;
  /** Why the slip stopped: a lapse, a failed step, or the core not starting. */
  error: Ref<string>;
}

/** The running core. */
interface Live {
  session: Session;
  kit: SlipKit;
  /** A new session with a freshly signed policy, for when the old one expires. */
  restart: () => Promise<Session>;
  waiting: Waiting | null;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run `fn` once the browser is idle, so the core never competes with first paint. */
function whenIdle(fn: () => void) {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 200);
  }
}

/** The deadline that matters in the current phase, and what runs out at it. */
function deadline(state: SlipState, live: Live): [Lapse, number] | null {
  if (state.phase.value === 'waiting' && live.waiting) {
    return ['proposal', live.waiting.proposal.expires];
  }

  const until = state.receipt.value?.until;

  return state.phase.value === 'committed' && until != null
    ? ['undo', until]
    : null;
}

/** If the policy or the phase's deadline has run out, say so and stop; true if it had. */
function stopIfLapsed(state: SlipState, live: Live): boolean {
  const d = deadline(state, live);
  const l = lapsed(nowSec(), {
    grant: live.session.grantExpires,
    proposal: d?.[0] === 'proposal' ? d[1] : null,
    undo: d?.[0] === 'undo' ? d[1] : null,
  });

  if (!l) {
    return false;
  }

  const at = l === 'policy' ? live.session.grantExpires : (d?.[1] ?? nowSec());

  state.error.value = lapseText(l, utcClock(at));
  state.status.value = state.error.value;
  state.phase.value = 'expired';

  return true;
}

/** Ask for a fresh proposal, re-signing the policy first if it has expired. */
async function propose(state: SlipState, live: Live) {
  if (nowSec() >= live.session.grantExpires) {
    live.session = await live.restart();
  }

  const w = await live.session.propose(tomorrow());

  live.waiting = w;
  state.slip.value = slipView(live.kit, w.proposal, w.consent, w.reason);
  state.receipt.value = null;
  state.undone.value = null;
  state.phase.value = 'waiting';
}

/** Run a step; on failure keep the slip, say what went wrong and offer Start again. */
async function step(state: SlipState, from: Phase, run: () => Promise<void>) {
  state.phase.value = from;

  try {
    await run();
  } catch (e) {
    state.error.value = message(e);
    state.status.value = `${state.error.value} Start again for a new proposal.`;
    state.phase.value = 'error';
  }
}

/**
 * Load the SDK and the example shop, sign the example policy and get the first proposal.
 * `attach` gets the running core before the first proposal, so its deadline is watched.
 */
async function start(state: SlipState, attach: (l: Live) => void) {
  try {
    const [sdk, examples] = await Promise.all([
      import('@yea-protocol/sdk'),
      import('@examples/shop.ts'),
    ]);
    const restart = () =>
      Session.start(sdk, examples.shop, landingCaveats(nowSec()));
    const live: Live = {
      session: await restart(),
      kit: sdk,
      restart,
      waiting: null,
    };

    attach(live);
    state.live.value = true;
    await step(state, 'loading', () => propose(state, live));
  } catch (e) {
    state.error.value = message(e);
    state.phase.value = 'unavailable';
  }
}

/** The visitor approves: sign the consent, commit, and show the receipt. */
async function approve(state: SlipState, live: Live) {
  const w = live.waiting;

  if (!w || state.phase.value !== 'waiting' || stopIfLapsed(state, live)) {
    return;
  }

  await step(state, 'approving', async () => {
    const done = await live.session.approve(w);
    const r = receiptView(done.receipt);

    state.receipt.value = r;
    state.phase.value = 'committed';
    state.status.value = `Approved. Receipt ${r.id}: the order is placed. ${r.undoUntil ? `You can undo it until ${r.undoUntil}.` : "It can't be undone."}`;
  });
}

async function undo(state: SlipState, live: Live) {
  const r = state.receipt.value;

  if (!r || state.phase.value !== 'committed' || stopIfLapsed(state, live)) {
    return;
  }

  await step(state, 'undoing', async () => {
    const done = await live.session.undo(r.id);

    state.undone.value = undoneView(done.receipt);
    state.phase.value = 'undone';
    state.status.value = `Undone. Receipt ${done.receipt.id} reverses ${r.id}.`;
  });
}

async function again(state: SlipState, live: Live) {
  await step(state, 'loading', async () => {
    await propose(state, live);
    state.status.value = `New proposal ${state.slip.value.id}, waiting on you.`;
  });
}

/** While a proposal waits or an undo window is open, stop the slip when it runs out. */
function watchDeadlines(state: SlipState, current: () => Live | null) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  watch(state.phase, () => {
    clearTimeout(timer);

    const live = current();
    const d = live && deadline(state, live);

    if (live && d) {
      timer = setTimeout(
        () => stopIfLapsed(state, live),
        (d[1] - nowSec()) * 1000 + 500,
      );
    }
  });
}

export function useSlip() {
  const state: SlipState = {
    phase: ref<Phase>('loading'),
    live: ref(false),
    slip: shallowRef<SlipView>(RECORDED.slip),
    receipt: shallowRef<ReceiptView | null>(null),
    undone: shallowRef<UndoneView | null>(null),
    status: ref(''),
    error: ref(''),
  };
  let live: Live | null = null;
  /** Run an action once the core is live; before that there is nothing to act on. */
  const withLive = (fn: (s: SlipState, l: Live) => Promise<void>) => () =>
    live ? fn(state, live) : Promise.resolve();

  watchDeadlines(state, () => live);
  onMounted(() =>
    whenIdle(() => {
      void start(state, (l) => {
        live = l;
      });
    }),
  );

  return {
    ...state,
    approve: withLive(approve),
    undo: withLive(undo),
    again: withLive(again),
  };
}
