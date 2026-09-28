/**
 * The hero slip's state: it starts from the recorded exchange (so the page paints without
 * JavaScript), loads the real core when the browser is idle, and swaps in a live proposal
 * the visitor can approve, then undo, then start again.
 */
import { onMounted, type Ref, ref, type ShallowRef, shallowRef } from 'vue';
import { RECORDED } from './exchange';
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
} from './slip-view';

export type Phase =
  | 'loading'
  | 'waiting'
  | 'approving'
  | 'committed'
  | 'undoing'
  | 'undone'
  | 'failed';

/** Run `fn` once the browser is idle, so the core never competes with first paint. */
function whenIdle(fn: () => void) {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 200);
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the slip shows. */
interface SlipState {
  phase: Ref<Phase>;
  slip: ShallowRef<SlipView>;
  receipt: ShallowRef<ReceiptView | null>;
  undone: ShallowRef<UndoneView | null>;
  /** The live region's one line: empty until the visitor acts. */
  status: Ref<string>;
  error: Ref<string>;
}

/** The running core, once it has loaded. */
interface Live {
  session: Session;
  kit: SlipKit;
  waiting: Waiting | null;
}

/** Ask for a fresh proposal: it replaces the slip, waiting on the visitor. */
async function propose(state: SlipState, live: Live) {
  const w = await live.session.propose(tomorrow());

  live.waiting = w;
  state.slip.value = slipView(live.kit, w.proposal, w.consent, w.reason);
  state.receipt.value = null;
  state.undone.value = null;
  state.phase.value = 'waiting';
}

/** Run a step; on failure keep the slip and say what went wrong. */
async function step(state: SlipState, from: Phase, run: () => Promise<void>) {
  state.phase.value = from;

  try {
    await run();
  } catch (e) {
    state.error.value = message(e);
    state.phase.value = 'failed';
    state.status.value = `Something went wrong: ${state.error.value}`;
  }
}

/** Load the SDK and the example shop, sign the example policy and get the first proposal. */
async function start(state: SlipState): Promise<Live | null> {
  let live: Live | null = null;

  await step(state, 'loading', async () => {
    const [sdk, examples] = await Promise.all([
      import('@yea-protocol/sdk'),
      import('@examples/shop.ts'),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const session = await Session.start(
      sdk,
      examples.shop,
      landingCaveats(now),
    );

    live = { session, kit: sdk, waiting: null };
    await propose(state, live);
  });

  return live;
}

/** The visitor approves: sign the consent, commit, and show the receipt. */
async function approve(state: SlipState, live: Live) {
  const w = live.waiting;

  if (!w || state.phase.value !== 'waiting') {
    return;
  }

  await step(state, 'approving', async () => {
    const done = await live.session.approve(w);
    const r = receiptView(done.receipt);

    state.receipt.value = r;
    state.phase.value = 'committed';
    state.status.value = `Approved. Receipt ${r.id}: the order is placed. You can undo it until ${r.undoUntil ?? 'never'}.`;
  });
}

async function undo(state: SlipState, live: Live) {
  const r = state.receipt.value;

  if (!r || state.phase.value !== 'committed') {
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

export function useSlip() {
  const state: SlipState = {
    phase: ref<Phase>('loading'),
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

  onMounted(() =>
    whenIdle(() => {
      void start(state).then((l) => {
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
