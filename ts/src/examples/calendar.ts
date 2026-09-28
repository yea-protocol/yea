/**
 * A calendar that speaks YEA. Agents say what they want ("move my 1:1 with Ana to
 * Thursday"); the calendar answers with proposals whose effects, risk and undo window
 * are explicit. Nothing changes until COMMIT, and every change can be undone for a day.
 */
import {
  clarify,
  create,
  fix,
  type Plan,
  remove,
  send,
  service,
  update,
  YeaError,
} from '../index.js';

interface Ev {
  id: string;
  title: string;
  start: string;
  end: string;
  with: string[];
}

const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

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
      run: ({ params }) => ({
        day: params.day,
        slots: freeSlots(events, params.day, params.minutes ?? 30),
      }),
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

// [days after tomorrow, hour, minute], in UTC.
type At = [day: number, hour: number, minute?: number];

interface Seed extends Omit<Ev, 'start' | 'end'> {
  start: At;
  end: At;
}

const SEED: Seed[] = [
  {
    id: 'e1',
    title: 'Standup',
    start: [0, 9],
    end: [0, 9, 15],
    with: ['team@acme.co'],
  },
  {
    id: 'e2',
    title: '1:1 with Ana',
    start: [0, 14],
    end: [0, 14, 30],
    with: ['ana.ruiz@acme.co'],
  },
  {
    id: 'e3',
    title: 'Design review',
    start: [0, 16],
    end: [0, 17],
    with: ['ana.ruiz@acme.co', 'lee@acme.co'],
  },
  {
    id: 'e4',
    title: 'Standup',
    start: [1, 9],
    end: [1, 9, 15],
    with: ['team@acme.co'],
  },
  {
    id: 'e5',
    title: 'Pipeline sync with Ana',
    start: [1, 11],
    end: [1, 11, 30],
    with: ['ana.li@acme.co'],
  },
  {
    id: 'e6',
    title: 'Lunch with Sam',
    start: [1, 12, 30],
    end: [1, 13, 30],
    with: ['sam@example.com'],
  },
  {
    id: 'e7',
    title: 'Standup',
    start: [2, 9],
    end: [2, 9, 15],
    with: ['team@acme.co'],
  },
  {
    id: 'e8',
    title: 'Quarterly planning',
    start: [2, 13],
    end: [2, 15],
    with: ['leads@acme.co'],
  },
];

function seedEvents(now: Date): Ev[] {
  const day0 =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) +
    86400_000;
  const at = ([d, h, m = 0]: At) =>
    iso(day0 + d * 86400_000 + h * HOUR + m * 60_000);

  return SEED.map((e) => ({
    ...e,
    start: at(e.start),
    end: at(e.end),
    with: [...e.with],
  }));
}

function find(events: Ev[], q: string) {
  const byId = events.find((e) => e.id === q);

  if (byId) {
    return [byId];
  }

  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);

  return events.filter((e) =>
    words.every((w) =>
      `${e.title} ${e.with.join(' ')}`.toLowerCase().includes(w),
    ),
  );
}

// Resolves one event, or answers with CLARIFY; each option is a params patch.
function pickEvent<T>(events: Ev[], q: string, then: (e: Ev) => T) {
  const m = find(events, q);

  if (!m.length) {
    throw new YeaError('not_found', `no event matches ${JSON.stringify(q)}`, {
      fix: [fix('ASK calendar.agenda to see events, then use an event id')],
    });
  }

  if (m.length > 1) {
    return clarify(
      `${m.length} events match "${q}". Which one?`,
      m.map((e) => ({
        label: `${e.title} · ${e.start} · ${e.with.join(', ')}`,
        params: { event: e.id },
      })),
    );
  }

  return then(m[0]);
}

const overlaps = (events: Ev[], s: number, e: number, skip?: string) =>
  events.find(
    (x) => x.id !== skip && Date.parse(x.start) < e && Date.parse(x.end) > s,
  );

function freeSlots(events: Ev[], day: string, minutes: number, skip?: string) {
  const out: string[] = [];
  const base = Date.parse(`${day}T00:00:00Z`);

  for (
    let t = base + 9 * HOUR;
    t + minutes * 60_000 <= base + 18 * HOUR;
    t += 30 * 60_000
  ) {
    if (!overlaps(events, t, t + minutes * 60_000, skip)) {
      out.push(iso(t));
    }
  }

  return out;
}

function agenda(events: Ev[], params: { day?: string; query?: string }) {
  return (params.query ? find(events, params.query) : events)
    .filter((e) => !params.day || e.start.startsWith(params.day))
    .map((e) => ({
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      with: e.with.join(' '),
    }));
}

function movePlan(e: Ev, startMs: number): Plan {
  const dur = Date.parse(e.end) - Date.parse(e.start);
  const before = { start: e.start, end: e.end };
  const to = { start: iso(startMs), end: iso(startMs + dur) };

  return {
    summary: `Move "${e.title}" to ${to.start}`,
    effects: [
      update(`event/${e.id}`, 'start', e.start, to.start),
      ...e.with.map((w) => send(w, 'updated invite')),
    ],
    undoWindow: 86400,
    apply: () => {
      Object.assign(e, to);

      return { event: e.id, start: e.start };
    },
    revert: () => {
      Object.assign(e, before);
    },
  };
}

function reschedulePlans(
  events: Ev[],
  e: Ev,
  params: { to?: string; day?: string },
) {
  return params.to
    ? moveTo(events, e, params.to)
    : moveOnDay(events, e, params.day ?? e.start.slice(0, 10));
}

// An exact new time: it must be in the future and free.
function moveTo(events: Ev[], e: Ev, to: string) {
  const dur = Date.parse(e.end) - Date.parse(e.start);
  const s = Date.parse(to);

  if (s < Date.now()) {
    throw new YeaError('invalid_params', `\`to\` is in the past (${to})`, {
      fix: [fix('use a future time', { to: iso(s + 365 * 86400_000) })],
    });
  }

  const clash = overlaps(events, s, s + dur, e.id);

  if (clash) {
    const day = to.slice(0, 10);
    const alts = freeSlots(events, day, dur / 60_000, e.id).slice(0, 3);

    throw new YeaError('conflict', `${to} overlaps "${clash.title}"`, {
      fix: alts.map((t) => fix(`use free slot ${t}`, { to: t })),
    });
  }

  return movePlan(e, s);
}

// Only a day: one proposal per free slot, up to three.
function moveOnDay(events: Ev[], e: Ev, day: string) {
  const dur = Date.parse(e.end) - Date.parse(e.start);
  const slots = freeSlots(events, day, dur / 60_000, e.id).slice(0, 3);

  if (!slots.length) {
    throw new YeaError('not_found', `no free slot on ${day}`, {
      fix: [
        fix('try another day', {
          day: iso(Date.parse(day) + 86400_000).slice(0, 10),
        }),
      ],
    });
  }

  return slots.map((t) => movePlan(e, Date.parse(t)));
}

function cancelPlan(events: Ev[], e: Ev, note?: string): Plan {
  return {
    summary: `Cancel "${e.title}" (${e.start})`,
    effects: [
      remove(`event/${e.id}`),
      ...e.with.map((w) =>
        send(w, note ? `cancellation: ${note}` : 'cancellation'),
      ),
    ],
    risk: e.with.length > 1 ? 'medium' : 'low',
    undoWindow: 86400,
    apply: () => {
      events.splice(events.indexOf(e), 1);

      return { cancelled: e.id };
    },
    revert: () => {
      events.push(e);
    },
  };
}

interface Booking {
  title: string;
  with: string[];
  day: string;
  minutes?: number;
}

function bookPlans(events: Ev[], params: Booking, nextId: () => string) {
  const minutes = params.minutes ?? 30;

  return freeSlots(events, params.day, minutes)
    .slice(0, 3)
    .map((t): Plan => {
      const ev: Ev = {
        id: nextId(),
        title: params.title,
        start: t,
        end: iso(Date.parse(t) + minutes * 60_000),
        with: params.with,
      };

      return {
        summary: `Book "${ev.title}" at ${t} (${minutes}m)`,
        effects: [
          create(`event/${ev.id}`, `${t} · ${minutes}m`),
          ...ev.with.map((w) => send(w, 'invite')),
        ],
        undoWindow: 86400,
        apply: () => {
          events.push(ev);

          return { event: ev.id };
        },
        revert: () => {
          events.splice(events.indexOf(ev), 1);
        },
      };
    });
}
