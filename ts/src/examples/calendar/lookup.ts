/** Finding the event an agent means, by id or words from its title or attendees; several matches get CLARIFY. */
import { clarify, fix, YeaError } from '../../index.js';
import type { Ev } from './data.js';

export function find(events: Ev[], q: string) {
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
export function pickEvent<T>(events: Ev[], q: string, then: (e: Ev) => T) {
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
