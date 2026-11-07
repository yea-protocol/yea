/**
 * Closed options (SPEC-mcp-ts, "Closed options"). Every options object an author passes is
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
  /** An array's rule for each item, so each is checked too. */
  items?: Rule;
}

export type Rules = Record<string, Rule>;

const rule = (is: string, ok: (v: unknown) => boolean): Rule => ({ is, ok });

/** `'a', 'b' or 'c'`. */
const listed = (values: readonly string[]) =>
  values
    .map((v) => `'${v}'`)
    .join(', ')
    .replace(/, ([^,]*)$/, ' or $1');

/**
 * A literal, or an object made by `Object.create(null)`. Not a Map, a Promise or a class instance:
 * these checks read a key through the prototype, while the code that uses the options may read
 * own keys only (`readTightening` does), so the two would see different rules.
 */
const isPlainObject = (v: unknown): v is Obj => {
  if (!isObject(v)) {
    return false;
  }

  const proto: unknown = Object.getPrototypeOf(v);

  return proto === Object.prototype || proto === null;
};

export const aString = rule('a string', (v) => typeof v === 'string');
export const aBoolean = rule('true or false', (v) => typeof v === 'boolean');
export const aFunction = rule('a function', (v) => typeof v === 'function');
export const aPlainObject = rule('a plain object', isPlainObject);
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
  ...aPlainObject,
  fields: rules,
});

/** An array each of whose items `item` takes; an error names the item (`icons[0].theme`). */
export const arrayOf = (is: string, item: Rule): Rule => ({
  is,
  ok: (v) => Array.isArray(v),
  items: required(item),
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

  if (r.items && Array.isArray(v)) {
    for (const [i, item] of v.entries()) {
      checkValue(where, `${name}[${i}]`, item, r.items);
    }
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

/**
 * Throws unless `o` is a plain object `rules` takes; `where` names the function, as in `yea()`.
 * An un-awaited Promise or a Map of options is refused too, rather than read as no options.
 */
export function checkOptions(where: string, o: unknown, rules: Rules) {
  if (!isPlainObject(o)) {
    throw new TypeError(`${where}: the options must be a plain object`);
  }

  checkKeys(where, o, rules, '');
}
