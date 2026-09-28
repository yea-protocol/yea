/**
 * Input schemas for the bridge's tools (SPEC-bridge, "Parameters"): a capability's compact
 * `params` (SPEC.md §4.1.1) as JSON Schema, and a Standard Schema that passes arguments through
 * unchanged, because the service validates them itself.
 */
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { printable } from '@yea-protocol/sdk';

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The job tools' own fields: a capability param with one of these names would shadow it. */
export const JOB_FIELDS = ['goal', 'preview', 'proposal'];

/** Nesting deeper than this maps to no constraint, so a hostile schema can't recurse forever. */
const MAX_DEPTH = 16;

const BASES: Record<string, Obj> = {
  string: { type: 'string' },
  int: { type: 'integer' },
  number: { type: 'number' },
  bool: { type: 'boolean' },
  date: { type: 'string', format: 'date' },
  datetime: { type: 'string', format: 'date-time' },
  any: {},
};

/** A base type: a named scalar, an enum (`a|b|c`), or no constraint for anything else. */
function baseSchema(base: string): Obj {
  if (Object.hasOwn(BASES, base)) {
    return { ...BASES[base] };
  }

  return base.includes('|') ? { type: 'string', enum: base.split('|') } : {};
}

/** A type string: `base[]? — description`. */
export function typeSchema(type: string): Obj {
  const cut = type.indexOf(' — ');
  const t = (cut < 0 ? type : type.slice(0, cut)).trim();
  const description = cut < 0 ? '' : printable(type.slice(cut + 3).trim());
  const array = t.endsWith('[]');
  const base = baseSchema(array ? t.slice(0, -2).trim() : t);
  const schema = array ? { type: 'array', items: base } : base;

  return description ? { ...schema, description } : schema;
}

/** One param's value: a type string, a nested object, or `[{…}]`, an array of that object. */
function valueSchema(v: unknown, depth: number): Obj {
  if (typeof v === 'string') {
    return typeSchema(v);
  }

  if (Array.isArray(v)) {
    return v.length === 1 && isObject(v[0])
      ? { type: 'array', items: objectSchema(v[0], depth + 1) }
      : {};
  }

  return isObject(v) ? objectSchema(v, depth + 1) : {};
}

/** A compact params object as a JSON Schema object; a name ending in `?` is optional. */
export function objectSchema(params: unknown, depth = 0): Obj {
  if (!isObject(params) || depth > MAX_DEPTH) {
    return { type: 'object' };
  }

  const entries = Object.entries(params).map(([raw, v]) => {
    const optional = raw.endsWith('?');

    return {
      name: optional ? raw.slice(0, -1) : raw,
      optional,
      schema: valueSchema(v, depth),
    };
  });
  const required = entries.filter((e) => !e.optional).map((e) => e.name);

  return {
    type: 'object',
    // fromEntries, not assignment: a param named `__proto__` must stay a plain key.
    properties: Object.fromEntries(entries.map((e) => [e.name, e.schema])),
    ...(required.length ? { required } : {}),
  };
}

/** The params a capability declares that a job tool reserves for itself. */
export const reservedParams = (params: unknown): string[] =>
  isObject(params)
    ? Object.keys(params)
        .map((k) => (k.endsWith('?') ? k.slice(0, -1) : k))
        .filter((k) => JOB_FIELDS.includes(k))
    : [];

const JOB_PROPERTIES: Obj = {
  goal: {
    type: 'string',
    description: "The user's goal in their words, for services that use it.",
  },
  preview: {
    type: 'boolean',
    description: 'Only show the proposals; nothing is committed or kept.',
  },
  proposal: {
    type: 'string',
    description:
      "Commit this proposal (an id from an earlier call with the same arguments), if the user's grant allows it.",
  },
};

/** A job tool's schema: the params plus `goal`, `preview` and `proposal`. */
export function withJobFields(schema: Obj): Obj {
  const properties = isObject(schema.properties) ? schema.properties : {};

  return { ...schema, properties: { ...properties, ...JOB_PROPERTIES } };
}

/** The input schema of a generic `<service>_ask` or `<service>_intent` tool. */
export function genericSchema(kind: 'ask' | 'intent'): Obj {
  const schema = {
    type: 'object',
    properties: {
      capability: {
        type: 'string',
        description:
          "One of the service's capabilities (see the instructions).",
      },
      params: {
        type: 'object',
        description: "The capability's params, as its entry lists them.",
      },
    },
    required: ['capability'],
  };

  return kind === 'intent' ? withJobFields(schema) : schema;
}

/**
 * A Standard Schema whose JSON Schema is `json` and whose validation passes any object through
 * unchanged: the service validates params itself, and teaches the model with its own errors.
 */
export function passThrough(json: Obj): StandardSchemaWithJSON<Obj, Obj> {
  return {
    '~standard': {
      version: 1,
      vendor: 'yea-bridge',
      validate: (value: unknown) =>
        isObject(value)
          ? { value }
          : { issues: [{ message: 'arguments must be an object' }] },
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}
