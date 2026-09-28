/**
 * What the calendar example's intents propose: moving, cancelling and booking meetings, each a
 * Plan with its effects, a day to undo it, and how to apply and revert it.
 */
import {
  create,
  fix,
  type Plan,
  remove,
  send,
  update,
  YeaError,
} from '../../index.js';
import { type Ev, iso } from './data.js';
import { freeSlots, overlaps } from './reads.js';

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

export function reschedulePlans(
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

export function cancelPlan(events: Ev[], e: Ev, note?: string): Plan {
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

export interface Booking {
  title: string;
  with: string[];
  day: string;
  minutes?: number;
}

export function bookPlans(events: Ev[], params: Booking, nextId: () => string) {
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
