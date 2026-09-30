/**
 * One run of an example, straight to its outcome: the agent asks, the service proposes, the
 * agent commits, and the slip either waits on the person or shows the receipt. Nothing is
 * paced; the lead-up above the slip lets the visitor step back through the stops themselves.
 *
 * Its runtime imports name their `.ts` files, so the tests can run it under Node.
 */
import { landingCaveats } from './policy.ts';
import { SCENES, tomorrow } from './scenes.ts';
import { type Answer, Session } from './session.ts';
import { receiptView, slipView } from './slip-view.ts';
import { LAST_STOP, type Progress } from './trail.ts';
import type { Live, SlipState } from './use-slip';

const nowSec = () => Math.floor(Date.now() / 1000);

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
 * a meeting cancelled by the last run is back. A run that a newer one replaced stops quietly,
 * and writes nothing; a run that fails says why and offers Start again.
 */
export async function runScene(state: SlipState, live: Live) {
  live.run += 1;

  const run = live.run;

  try {
    await lead(state, live, run);
  } catch (e) {
    if (live.run === run) {
      state.error.value = e instanceof Error ? e.message : String(e);
      state.status.value = `${state.error.value} Start again for a new proposal.`;
      state.phase.value = 'error';
    }
  }
}

async function lead(state: SlipState, live: Live, run: number) {
  const scene = SCENES[state.scene.value];
  const params = scene.params(tomorrow());
  const blank: Progress = {
    scene,
    params,
    proposals: null,
    outcome: null,
    answer: '',
  };

  // Busy from the first moment, so nothing from the last run shows or can be pressed, and
  // the lead-up shows the outcome again.
  live.waiting = null;
  state.receipt.value = null;
  state.undone.value = null;
  state.error.value = '';
  state.progress.value = blank;
  state.view.value = LAST_STOP;
  state.phase.value = 'checking';

  const session = await Session.start(
    live.sdk,
    live.services[scene.service],
    landingCaveats(nowSec()),
  );

  if (live.run !== run) {
    return;
  }

  live.session = session;

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

  const answer = await session.commit(p);

  if (live.run === run) {
    land(state, live, answer);
  }
}
