/**
 * Which frames of a known kind Lens renders as that kind (SPEC §9.2, well-formed frames): each
 * listed member has its type. Anything else renders as an unknown kind, so a missing or
 * wrong-typed member can't make rendering throw.
 */
import type { More } from '../types.js';
import { isObject } from '../util.js';

/**
 * A member's type: a JSON type by name, `[t]` for an array of `t`, or an object's members. A
 * member named `k?` may be absent or null.
 */
type Shape =
  | 'any'
  | 'string'
  | 'boolean'
  | 'integer'
  | 'scalar'
  | 'params'
  | readonly [Shape]
  | { readonly [member: string]: Shape };

const EFFECT: Shape = {
  op: 'string',
  target: 'string',
  'field?': 'string',
  'detail?': 'string',
  'from?': 'scalar',
  'to?': 'scalar',
};

const SHAPES: Record<string, Shape> = {
  BRIEF: {
    service: { id: 'string', name: 'string', 'summary?': 'string' },
    capabilities: [
      {
        kind: 'string',
        name: 'string',
        'summary?': 'string',
        'risk?': 'string',
        'params?': 'params',
      },
    ],
  },
  ANSWER: { data: 'any' },
  PROPOSALS: {
    proposals: [{ id: 'string', summary: 'string', effects: [EFFECT] }],
  },
  CLARIFY: { question: 'string', options: [{ label: 'string' }] },
  RECEIPT: {
    receipt: {
      id: 'string',
      summary: 'string',
      'undoes?': 'string',
      'effects?': [EFFECT],
    },
    'replay?': 'boolean',
    'auto?': 'boolean',
  },
  ERROR: {
    code: 'string',
    message: 'string',
    'fix?': [{ say: 'string', 'params?': {} }],
    'need?': ['any'],
    'consent?': { hash: 'string', summary: 'string' },
  },
  EVENT: { message: 'string' },
};

/** A Map, so a `kind` like `constructor` or `__proto__` finds nothing. */
const KINDS = new Map(Object.entries(SHAPES));

const MORE: Shape = [
  { remaining: 'integer', path: 'string', handle: 'string', est: 'integer' },
];

/** How deep a param schema may nest, so checking and rendering one can't overflow the stack. */
const MAX_PARAM_DEPTH = 32;

/**
 * A param schema: every value a type name, a nested schema, or a one-element array of either,
 * nested at most MAX_PARAM_DEPTH deep.
 */
function isParams(v: unknown, depth = 0): boolean {
  const isType = (t: unknown): boolean =>
    typeof t === 'string' ||
    (depth < MAX_PARAM_DEPTH &&
      (Array.isArray(t)
        ? t.length === 1 && isParams({ t: t[0] }, depth + 1)
        : isParams(t, depth + 1)));

  return isObject(v) && Object.values(v).every(isType);
}

function fits(v: unknown, s: Shape): boolean {
  switch (s) {
    case 'any':
      return v !== undefined;
    case 'string':
    case 'boolean':
      return typeof v === s;
    case 'integer':
      return Number.isSafeInteger(v);
    case 'scalar':
      return ['string', 'number', 'boolean'].includes(typeof v);
    case 'params':
      return isParams(v);
  }

  if (Array.isArray(s)) {
    return Array.isArray(v) && v.every((x) => fits(x, s[0]));
  }

  return isObject(v) && Object.entries(s).every(([k, t]) => member(v, k, t));
}

function member(o: Record<string, unknown>, k: string, t: Shape): boolean {
  if (!k.endsWith('?')) {
    return fits(o[k], t);
  }

  const v = o[k.slice(0, -1)];

  return v === undefined || v === null || fits(v, t);
}

const isMoreList = (v: unknown): v is More[] => fits(v, MORE);

/** The frame's `more` lines to render: none when it's absent or null, null when it's malformed. */
export function moreOf(frame: Record<string, unknown>): More[] | null {
  const m = frame.more;

  if (m === undefined || m === null) {
    return [];
  }

  return isMoreList(m) ? m : null;
}

/** True when the frame is of a known kind and has every member that kind's rendering reads. */
export function kindFits(frame: Record<string, unknown>): boolean {
  const shape =
    typeof frame.kind === 'string' ? KINDS.get(frame.kind) : undefined;

  return shape !== undefined && fits(frame, shape);
}
