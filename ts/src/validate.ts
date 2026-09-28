/** Light validation of params against the compact schema (SPEC §4.1.1), producing teaching errors. */
import { fix, YeaError } from './errors.js';
import type { Fix, ParamSchema } from './types.js';
import { isObject } from './util.js';

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array(b.length).fill(0),
  ]);

  for (let j = 1; j <= b.length; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }

  return d[a.length][b.length];
}

export function closest(word: string, options: string[]): string | undefined {
  if (word.length > 64) {
    return undefined; // suggestions are for typos; don't pay O(n·m) on garbage
  }

  let best: string | undefined;
  let bestD = Infinity;

  for (const o of options) {
    const dd = distance(word.toLowerCase(), o.toLowerCase());

    if (dd < bestD) {
      best = o;
      bestD = dd;
    }
  }

  return best !== undefined && bestD <= Math.max(2, Math.floor(word.length / 3))
    ? best
    : undefined;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Named scalar types: a test for the value, and how to describe what was wanted. */
const SCALARS = new Map<
  string,
  { test: (v: unknown) => boolean; want: string }
>([
  ['string', { test: (v) => typeof v === 'string', want: 'a string' }],
  ['int', { test: Number.isInteger, want: 'an integer' }],
  ['number', { test: (v) => typeof v === 'number', want: 'a number' }],
  ['bool', { test: (v) => typeof v === 'boolean', want: 'true or false' }],
  [
    'date',
    {
      test: (v) => typeof v === 'string' && DATE.test(v),
      want: 'a date like 2026-09-24',
    },
  ],
  [
    'datetime',
    {
      test: (v) => typeof v === 'string' && DATETIME.test(v),
      want: 'an ISO datetime like 2026-09-24T15:00:00Z',
    },
  ],
  ['any', { test: () => true, want: 'anything' }],
]);

/** What `v` should have been for `type` (e.g. "an integer"), or null if it conforms. Unknown types pass. */
function checkType(type: string, v: unknown): string | null {
  const base = type.split(' — ')[0].trim();

  if (base.endsWith('[]')) {
    const item = base.slice(0, -2);

    return Array.isArray(v) && v.every((x) => !checkType(item, x))
      ? null
      : `an array of ${item}`;
  }

  const scalar = SCALARS.get(base);

  if (scalar) {
    return scalar.test(v) ? null : scalar.want;
  }

  if (base.includes('|')) {
    const opts = base.split('|');

    return opts.includes(String(v)) ? null : `one of ${opts.join(', ')}`;
  }

  return null;
}

/** Problems inside a nested object, each already prefixed with `path`. */
function nestedProblems(
  schema: ParamSchema | undefined,
  value: Record<string, unknown>,
  path: string,
): string[] {
  try {
    validateParams(schema, value, path);

    return [];
  } catch (e) {
    return [(e as Error).message];
  }
}

function arrayOfObjectsProblems(
  label: string,
  schema: ParamSchema | undefined,
  v: unknown,
): string[] {
  if (!Array.isArray(v)) {
    return [`\`${label}\` must be an array of objects`];
  }

  return v.flatMap((item, i) =>
    isObject(item)
      ? nestedProblems(schema, item, `${label}.${i}.`)
      : [`\`${label}.${i}\` must be an object`],
  );
}

/** Problems with one declared param; `label` is its full dotted path. */
function fieldProblems(
  label: string,
  type: ParamSchema[string],
  v: unknown,
  optional: boolean,
): string[] {
  if (v === undefined || v === null) {
    return optional
      ? []
      : [
          `missing \`${label}\` (${typeof type === 'string' ? type : 'object'})`,
        ];
  }

  if (typeof type === 'string') {
    const want = checkType(type, v);

    return want
      ? [`\`${label}\` must be ${want} (got ${JSON.stringify(v)})`]
      : [];
  }

  if (Array.isArray(type)) {
    return arrayOfObjectsProblems(label, type[0], v);
  }

  if (!isObject(v)) {
    return [`\`${label}\` must be an object`];
  }

  return nestedProblems(type, v, `${label}.`);
}

/** Params the schema doesn't declare, with a rename fix when one is a likely typo. */
function unknownParams(
  params: Record<string, unknown>,
  names: string[],
  path: string,
): { problems: string[]; fixes: Fix[] } {
  const problems: string[] = [];
  const fixes: Fix[] = [];

  for (const k of Object.keys(params)) {
    if (names.includes(k)) {
      continue;
    }

    const near = closest(k, names);

    problems.push(`unknown param \`${path}${k}\``);

    if (near && params[near] === undefined) {
      fixes.push(
        fix(`rename \`${k}\` to \`${near}\``, { [k]: null, [near]: params[k] }),
      );
    }
  }

  return { problems, fixes };
}

/** Throws a YeaError(invalid_params) with fixes if params don't match the schema. */
export function validateParams(
  schema: ParamSchema | undefined,
  params: Record<string, unknown>,
  path = '',
): void {
  if (!schema) {
    return;
  }

  const problems: string[] = [];
  const names = Object.keys(schema).map((k) => k.replace(/\?$/, ''));

  for (const [raw, type] of Object.entries(schema)) {
    const name = raw.replace(/\?$/, '');

    problems.push(
      ...fieldProblems(`${path}${name}`, type, params[name], raw.endsWith('?')),
    );
  }

  const unknown = unknownParams(params, names, path);

  problems.push(...unknown.problems);

  if (problems.length) {
    throw new YeaError(
      'invalid_params',
      problems.join('; '),
      unknown.fixes.length ? { fix: unknown.fixes } : {},
    );
  }
}
