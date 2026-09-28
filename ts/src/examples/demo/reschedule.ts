/** The demo's calendar scene: HELLO, an INTENT that needs CLARIFY, an auto-commit, then UNDO. */
import type { Client } from '../../index.js';
import { day, type Narrator } from './narrator.js';

export async function reschedule(n: Narrator, cal: Client, calUrl: string) {
  n.say(n.agent, 'discovers what the calendar can do:');
  n.wire('HELLO', calUrl);
  n.show((await cal.hello()).lens);

  n.say(
    n.agent,
    `"move my 1:1 with Ana to ${day(3)}", said with intent instead of CRUD calls:`,
  );
  n.wire('INTENT', `calendar.reschedule {event:"Ana", day:"${day(3)}"} auto`);

  const q = await cal.intent(
    'calendar.reschedule',
    { event: 'Ana', day: day(3) },
    { auto: true },
  );

  n.show(q.lens);

  if (q.kind !== 'CLARIFY') {
    return;
  }

  n.say(
    n.agent,
    "picks option 1. The service knows it's low-risk and undoable, and the policy allows that, so it commits in the same round trip:",
  );
  n.wire(
    'INTENT',
    `calendar.reschedule ${JSON.stringify({ ...q.options[0].params, day: day(3) })} auto`,
  );

  const r = await cal.intent(
    'calendar.reschedule',
    { event: 'Ana', day: day(3), ...q.options[0].params },
    { auto: true },
  );

  n.show(r.lens);

  if (r.kind !== 'RECEIPT') {
    return;
  }

  n.say(n.human, `(simulated) "wait, not that day." The agent undoes it:`);
  n.wire('UNDO', r.receipt.id);
  n.show((await cal.undo(r.receipt.id)).lens);
}
