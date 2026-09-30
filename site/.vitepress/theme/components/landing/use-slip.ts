/**
 * The hero's state: which example is chosen, where its run has got to, and the slip. The page
 * paints the recorded dinner example (so it needs no JavaScript), loads the real core when the
 * browser is idle, then runs the chosen example live from the start (run-scene.ts). Once live
 * the visitor can approve, undo, start again or pick another example, and the slip says when
 * the proposal, the undo window or the example policy has run out instead of failing.
 */
import {
  onMounted,
  type Ref,
  ref,
  type ShallowRef,
  shallowRef,
  type UnwrapNestedRefs,
} from 'vue';
import { stopIfLapsed, watchDeadlines } from './deadlines';
import { RECORDED } from './exchange';
import { runScene } from './run-scene';
import { SCENES, type SceneKey, type ServiceKey } from './scenes';
import type { ServiceFactory, Session, SessionSdk, Waiting } from './session';
import {
  type ReceiptView,
  receiptView,
  type SlipKit,
  type SlipView,
  type UndoneView,
  undoneView,
} from './slip-view';
import type { Progress } from './trail';

/**
 * `loading` until the core is live; `unavailable` if it couldn't start at all; `asking`,
 * `proposed` and `checking` while a run leads up to its outcome; `expired` when something ran
 * out; `error` when a step failed.
 */
export type Phase =
  | 'loading'
  | 'unavailable'
  | 'asking'
  | 'proposed'
  | 'checking'
  | 'waiting'
  | 'approving'
  | 'committed'
  | 'undoing'
  | 'undone'
  | 'expired'
  | 'error';

/** What the hero shows. */
export interface SlipState {
  scene: Ref<SceneKey>;
  phase: Ref<Phase>;
  /** Whether the core is running; false while the recording is on show. */
  live: Ref<boolean>;
  /** How far the run has got, for the lead-up above the slip. */
  progress: ShallowRef<Progress>;
  slip: ShallowRef<SlipView>;
  receipt: ShallowRef<ReceiptView | null>;
  undone: ShallowRef<UndoneView | null>;
  /** The live region's one line: empty until something happens. */
  status: Ref<string>;
  /** Why the slip stopped: a lapse, a failed step, or the core not starting. */
  error: Ref<string>;
}

/** The running core. */
export interface Live {
  sdk: SessionSdk & SlipKit;
  services: Record<ServiceKey, ServiceFactory>;
  /** The current run's session, and its proposal while it waits on the person. */
  session: Session | null;
  waiting: Waiting | null;
  /** Counts runs, so a run that a newer one replaced can tell and stop. */
  run: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The recorded dinner example, as the lead-up shows it before the core runs. */
const RECORDED_PROGRESS: Progress = {
  scene: SCENES.dinner,
  params: RECORDED.params,
  proposals: {
    count: RECORDED.count,
    id: RECORDED.slip.id,
    summary: RECORDED.slip.summary,
  },
  outcome: 'asks',
  answer: RECORDED.slip.reason,
};

/** Run `fn` once the browser is idle, so the core never competes with first paint. */
function whenIdle(fn: () => void) {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 200);
  }
}

/**
 * Run a step; on failure keep the slip, say what went wrong and offer Start again. A step
 * that a newer run replaced (the visitor picked another example meanwhile) changes nothing.
 */
async function step(
  state: SlipState,
  live: Live,
  from: Phase | null,
  run: () => Promise<void>,
) {
  const mine = live.run;

  if (from) {
    state.phase.value = from;
  }

  try {
    await run();
  } catch (e) {
    if (live.run === mine) {
      state.error.value = message(e);
      state.status.value = `${state.error.value} Start again for a new proposal.`;
      state.phase.value = 'error';
    }
  }
}

/** Load the SDK and the example services, then run the chosen example. */
async function start(state: SlipState, attach: (l: Live) => void) {
  try {
    const [sdk, shop, calendar] = await Promise.all([
      import('@yea-protocol/sdk'),
      import('@examples/shop.ts'),
      import('@examples/calendar.ts'),
    ]);
    const live: Live = {
      sdk,
      services: { shop: shop.shop, calendar: calendar.calendar },
      session: null,
      waiting: null,
      run: 0,
    };

    attach(live);
    state.live.value = true;
    await step(state, live, null, () => runScene(state, live));
  } catch (e) {
    state.error.value = message(e);
    state.phase.value = 'unavailable';
  }
}

/** The visitor approves: sign the consent, commit, and show the receipt. */
async function approve(state: SlipState, live: Live) {
  const w = live.waiting;
  const s = live.session;

  if (
    !w ||
    !s ||
    state.phase.value !== 'waiting' ||
    stopIfLapsed(state, live)
  ) {
    return;
  }

  const run = live.run;

  await step(state, live, 'approving', async () => {
    const done = await s.approve(w);
    const r = receiptView(done.receipt);
    const scene = SCENES[state.scene.value];

    if (live.run !== run) {
      return;
    }

    state.receipt.value = r;
    state.phase.value = 'committed';
    state.status.value = `Approved. Receipt ${r.id}: ${scene.done} ${r.undoUntil ? `You can undo it until ${r.undoUntil}.` : "It can't be undone."}`;
  });
}

async function undo(state: SlipState, live: Live) {
  const r = state.receipt.value;
  const s = live.session;

  if (
    !r ||
    !s ||
    state.phase.value !== 'committed' ||
    stopIfLapsed(state, live)
  ) {
    return;
  }

  const run = live.run;

  await step(state, live, 'undoing', async () => {
    const done = await s.undo(r.id);

    if (live.run !== run) {
      return;
    }

    state.undone.value = undoneView(done.receipt);
    state.phase.value = 'undone';
    state.status.value = `Undone: ${SCENES[state.scene.value].undone} Receipt ${done.receipt.id} reverses ${r.id}.`;
  });
}

export function useSlip() {
  const state: SlipState = {
    scene: ref<SceneKey>('dinner'),
    phase: ref<Phase>('loading'),
    live: ref(false),
    progress: shallowRef<Progress>(RECORDED_PROGRESS),
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
  /** Run the chosen example again from the start. */
  const rerun = (s: SlipState, l: Live) =>
    step(s, l, null, () => runScene(s, l));

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
    again: withLive(rerun),
    /** Pick an example; once the core is live it runs from the start. */
    choose(key: SceneKey) {
      if (key !== state.scene.value) {
        state.scene.value = key;
        void withLive(rerun)();
      }
    },
  };
}

/** The hero's state as its components read it: `reactive(useSlip())`. */
export type SlipModel = UnwrapNestedRefs<ReturnType<typeof useSlip>>;
