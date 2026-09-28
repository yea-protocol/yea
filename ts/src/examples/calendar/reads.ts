/** What the calendar example's asks return: the agenda, and free slots on a day (which the intents reuse). */
import { type Ev, HOUR, iso } from './data.js';
import { find } from './lookup.js';

export const overlaps = (events: Ev[], s: number, e: number, skip?: string) =>
  events.find(
    (x) => x.id !== skip && Date.parse(x.start) < e && Date.parse(x.end) > s,
  );

export function freeSlots(
  events: Ev[],
  day: string,
  minutes: number,
  skip?: string,
) {
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

export function agenda(events: Ev[], params: { day?: string; query?: string }) {
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

export function freeTime(events: Ev[], day: string, minutes?: number) {
  return { day, slots: freeSlots(events, day, minutes ?? 30) };
}
