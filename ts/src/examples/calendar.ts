/**
 * A calendar that speaks YEA. Agents say what they want ("move my 1:1 with Ana to
 * Thursday"); the calendar answers with proposals whose effects, risk and undo window
 * are explicit. Nothing changes until COMMIT, and every change can be undone for a day.
 *
 * This file declares the service: each capability, its params and its risk. The code behind
 * them is in calendar/: data.ts (the events), lookup.ts (finding the one the agent means),
 * reads.ts (what each ask returns) and plans.ts (what each intent proposes).
 */
import { service } from '../index.js';
import { type Ev, seedEvents } from './calendar/data.js';
import { pickEvent } from './calendar/lookup.js';
import {
  type Booking,
  bookPlans,
  cancelPlan,
  reschedulePlans,
} from './calendar/plans.js';
import { agenda, freeTime } from './calendar/reads.js';

export function calendar(opts: {
  trust: string[] | ((principal: string) => boolean);
  id?: string;
}) {
  // Computed per call, not at module load: some runtimes (Workers) freeze the clock during startup.
  const events = seedEvents(new Date());
  let seq = 100;
  const nextId = () => `e${++seq}`;
  const pick = <T>(q: string, then: (e: Ev) => T) => pickEvent(events, q, then);

  return service({
    id: opts.id ?? 'calendar.example',
    name: 'Example Calendar',
    summary:
      'Your work calendar. Read your agenda, find free time, and book, move or cancel meetings. Invitees are notified automatically.',
    trust: opts.trust,
  })
    .ask('calendar.agenda', {
      summary: 'Events, optionally for one day and/or matching a query',
      params: {
        'day?': 'date',
        'query?': 'string — words in title or attendee',
      },
      run: ({ params }) => agenda(events, params),
    })
    .ask('calendar.free', {
      summary: 'Free slots on a day (09:00–18:00 UTC)',
      params: { day: 'date', 'minutes?': 'int' },
      run: ({ params }) => freeTime(events, params.day, params.minutes),
    })
    .intent('calendar.reschedule', {
      summary:
        'Move a meeting to a new time; with only `day`, proposes free slots',
      params: {
        event: 'string — id or words from the title',
        'to?': 'datetime',
        'day?': 'date',
      },
      risk: 'low',
      plan: ({ params }) =>
        pick(params.event, (e) => reschedulePlans(events, e, params)),
    })
    .intent('calendar.cancel', {
      summary: 'Cancel a meeting and notify attendees',
      params: {
        event: 'string — id or words from the title',
        'note?': 'string',
      },
      risk: 'medium',
      plan: ({ params }) =>
        pick(params.event, (e) => cancelPlan(events, e, params.note)),
    })
    .intent('calendar.book', {
      summary: 'Book a new meeting; proposes the first free slots',
      params: {
        title: 'string',
        with: 'string[] — emails',
        day: 'date',
        'minutes?': 'int',
      },
      // The service validated params against the schema above before plan() runs.
      plan: ({ params }) => bookPlans(events, params as Booking, nextId),
    });
}
