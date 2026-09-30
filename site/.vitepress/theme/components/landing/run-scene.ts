/**
 * One run of an example, paced so a person can follow it: the agent asks, the service
 * proposes, the policy checks the commit, and then the slip either waits on the person or
 * shows the receipt. The frames are real and come from the core as fast as it answers; only
 * the pauses between the stops are added. Under reduced motion there are none, and the slip
 * goes straight to the outcome.
 */
import { landingCaveats } from './policy';
import { SCENES, tomorrow } from './scenes';
import { type Answer, Session } from './session';
import { receiptView, slipView } from './slip-view';
import type { Progress } from './trail';
import type { Live, Phase, SlipState } from './use-slip';

/** How long each stop of the lead-up stays before the next, in ms. */
const PAUSE: Partial<Record<Phase, number>> = {
  asking: 1100,
  proposed: 1300,
  checking: 1000,
};

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const calm = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Show a stop of the lead-up and hold it; false if a newer run has taken over meanwhile. */
async function hold(state: SlipState, live: Live, run: number, phase: Phase) {
  if (calm()) {
    return live.run === run;
  }

  state.phase.value = phase;
  await sleep(PAUSE[phase] ?? 0);

  return live.run === run;
}

/** The slip after the commit is answered: waiting on the person, or committed. */
function land(state: SlipState, live: Live, answer: Answer) {
  const scene = SCENES[state.scene.value];
  const progress = state.progress.value;

  if (answer.outcome === 'asks') {
    const w = answer.waiting;

    live.waiting = w;
    state.slip.value = { ...state.slip.value, reason: w.reason };
    state.progress.value = { ...progress, outcome: 'asks', answer: w.reason };
    state.phase.value = 'waiting';
    state.status.value = `${scene.host} asks you to approve proposal ${w.proposal.id}. It's waiting on you.`;

    return;
  }

  const r = receiptView(answer.done.receipt);

  state.receipt.value = r;
  state.progress.value = { ...progress, outcome: 'within', answer: r.id };
  state.phase.value = 'committed';
  state.status.value = `${scene.done} It was inside your policy, so it went ahead without asking. Receipt ${r.id}.`;
}

/**
 * Run the chosen example from the start, with a freshly signed policy and a fresh service, so
 * a meeting cancelled by the last run is back. A run that a newer one replaced stops quietly.
 */
export async function runScene(state: SlipState, live: Live) {
  live.run += 1;

  const run = live.run;
  const scene = SCENES[state.scene.value];
  const params = scene.params(tomorrow());
  const blank: Progress = {
    scene,
    params,
    proposals: null,
    outcome: null,
    answer: '',
  };

  live.waiting = null;
  state.receipt.value = null;
  state.undone.value = null;
  state.error.value = '';
  state.progress.value = blank;

  const session = await Session.start(
    live.sdk,
    live.services[scene.service],
    landingCaveats(nowSec()),
  );

  live.session = session;

  if (!(await hold(state, live, run, 'asking'))) {
    return;
  }

  const p = await session.propose(scene.capability, params);

  if (live.run !== run) {
    return;
  }

  state.slip.value = slipView(live.sdk, p.proposal, {
    service: scene.host,
    hash: p.hash,
    reason: '',
  });
  state.progress.value = {
    ...blank,
    proposals: {
      count: p.count,
      id: p.proposal.id,
      summary: p.proposal.summary,
    },
  };

  if (
    !(await hold(state, live, run, 'proposed')) ||
    !(await hold(state, live, run, 'checking'))
  ) {
    return;
  }

  const answer = await session.commit(p);

  if (live.run === run) {
    land(state, live, answer);
  }
}
