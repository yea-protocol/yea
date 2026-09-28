/** The made-up events behind the calendar example: their shape, the seed, and UTC timestamps. */

export interface Ev {
  id: string;
  title: string;
  start: string;
  end: string;
  with: string[];
}

export const HOUR = 3600_000;

export const iso = (ms: number) =>
  new Date(ms).toISOString().replace('.000Z', 'Z');

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

export function seedEvents(now: Date): Ev[] {
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
