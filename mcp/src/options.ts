/**
 * Closed options (SPEC-mcp-ts, "Option refusals"). Every options object an author passes is
 * checked before anything is registered, served or written: an unknown key, a missing required
 * one, or a value not of its documented type (an unlisted enum value included) throws a
 * TypeError naming the key and what it takes. So a typo'd protection can't be silently off.
 */
import { isRisk } from '@yea-protocol/sdk';
import { isObject, type Obj } from './util.js';

/** What one option takes: `is` says it in the error, and `ok` checks it. */
export interface Rule {
  is: string;
  ok(v: unknown): boolean;
  required?: boolean;
  /** Refused whatever its value, because accepting it would mislead: `is` says why. */
  refused?: boolean;
  /** A nested object's own rules, so its keys are closed too. */
  fields?: Rules;
}

export type Rules = Record<string, Rule>;

const rule = (is: string, ok: (v: unknown) => boolean): Rule => ({ is, ok });

/** `'a', 'b' or 'c'`. */
const listed = (values: readonly string[]) =>
  values
    .map((v) => `'${v}'`)
    .join(', ')
    .replace(/, ([^,]*)$/, ' or $1');

export const aString = rule('a string', (v) => typeof v === 'string');
export const aBoolean = rule('true or false', (v) => typeof v === 'boolean');
export const aFunction = rule('a function', (v) => typeof v === 'function');
export const anObject = rule('an object', isObject);
export const aRisk = rule(listed(['low', 'medium', 'high']), isRisk);

export const strings = rule(
  'an array of strings',
  (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
);

/** An object with each of `methods`: how a store or a codec is recognised (they're interfaces). */
export const withMethods = (is: string, methods: readonly string[]) =>
  rule(
    is,
    (v) => isObject(v) && methods.every((m) => typeof v[m] === 'function'),
  );

/** One of `values`. */
export const oneOf = (...values: string[]) =>
  rule(listed(values), (v) => values.some((x) => x === v));

/** A whole number of at least `min`, as `serveFetch` checks its own. */
export const whole = (min: number) =>
  rule(
    `a whole number ≥ ${min}`,
    (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min,
  );

export const required = (r: Rule): Rule => ({ ...r, required: true });

/** A key that would mislead if it were accepted: refused, saying `why`. */
export const refused = (why: string): Rule => ({
  is: why,
  ok: () => false,
  refused: true,
});

/** An object whose keys are checked against `rules` too; an error names the path (`tighten.deny`). */
export const nested = (rules: Rules): Rule => ({
  ...anObject,
  fields: rules,
});

/** Throws for a value `r` doesn't take; undefined is absent, which only a required key refuses. */
function checkValue(where: string, name: string, v: unknown, r: Rule) {
  if (v === undefined) {
    if (r.required) {
      throw new TypeError(`${where}: ${name} is required: ${r.is}`);
    }

    return;
  }

  if (r.refused) {
    throw new TypeError(`${where}: ${name} isn't accepted: ${r.is}`);
  }

  if (!r.ok(v)) {
    throw new TypeError(`${where}: ${name} must be ${r.is}`);
  }

  if (r.fields && isObject(v)) {
    checkKeys(where, v, r.fields, `${name}.`);
  }
}

/** Throws for a key `rules` doesn't list (one set to undefined included), then checks each value. */
function checkKeys(where: string, o: Obj, rules: Rules, path: string) {
  const unknown = Object.keys(o).find((k) => !Object.hasOwn(rules, k));

  if (unknown !== undefined) {
    const known = Object.keys(rules).filter((k) => !rules[k].refused);

    throw new TypeError(
      `${where}: unknown option ${JSON.stringify(path + unknown)}; known: ${known.map((k) => path + k).join(', ')}`,
    );
  }

  for (const [key, r] of Object.entries(rules)) {
    checkValue(where, path + key, o[key], r);
  }
}

/** Throws unless `o` is an object `rules` takes; `where` names the function, as in `yea()`. */
export function checkOptions(where: string, o: unknown, rules: Rules) {
  if (!isObject(o)) {
    throw new TypeError(`${where}: the options must be an object`);
  }

  checkKeys(where, o, rules, '');
}
