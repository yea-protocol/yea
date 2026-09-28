/**
 * JSON Schema in an OpenAPI document: local `$ref` resolution, and the compact type strings
 * (SPEC §4.1.1) and one-line descriptions that capability params show.
 */
import { isObjectOrArray, type Json, prop } from './json.js';

/*
 * Minimal views of the OpenAPI nodes we read. The document is untrusted JSON, so every
 * field is optional and may be missing; reads go through `?.` exactly as for plain JSON.
 */
export interface SchemaNode {
  type?: string;
  format?: string;
  enum?: unknown;
  items?: unknown;
  properties?: Json;
  required?: string[];
  readOnly?: boolean;
  description?: string;
}

export interface ParameterNode {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
}

export interface RequestBodyNode {
  required?: boolean;
  content?: Record<string, { schema?: unknown } | undefined>;
}

/** Follow local `$ref` pointers (`#/…`), bounded against cycles. */
function resolve(spec: Json, v: unknown, depth = 0): unknown {
  if (!isObjectOrArray(v) || depth > 20) {
    return v;
  }

  const ref = v.$ref;

  if (typeof ref === 'string' && ref.startsWith('#/')) {
    const target = ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (o, k) => prop(o, k.replace(/~1/g, '/').replace(/~0/g, '~')),
        spec,
      );

    return resolve(spec, target, depth + 1);
  }

  return v;
}

/** `resolve`, viewing the result through one of the minimal node interfaces above. */
export const resolveAs = <T>(spec: Json, v: unknown) =>
  resolve(spec, v) as T | undefined;

/** A short string enum as `a|b|c`, or undefined when it wouldn't read well. */
function enumType(values: unknown): string | undefined {
  if (
    Array.isArray(values) &&
    values.length &&
    values.length <= 12 &&
    values.every((x: unknown) => typeof x === 'string' && !x.includes('|'))
  ) {
    return values.join('|');
  }

  return undefined;
}

const stringType = (format?: string) =>
  format === 'date' ? 'date' : format === 'date-time' ? 'datetime' : 'string';

/** JSON Schema → compact type string (SPEC §4.1.1). Lossy by design. */
export function typeOf(spec: Json, schema: unknown, depth = 0): string {
  const s = resolveAs<SchemaNode>(spec, schema) ?? {};
  const listed = enumType(s.enum);

  if (listed) {
    return listed;
  }

  switch (s.type) {
    case 'integer':
      return 'int';
    case 'number':
      return 'number';
    case 'boolean':
      return 'bool';
    case 'string':
      return stringType(s.format);
    case 'array':
      return depth < 2 ? `${typeOf(spec, s.items, depth + 1)}[]` : 'any';
    default:
      return 'any';
  }
}

/** First sentence of a description, cut at a word boundary: a hint for the model, not docs. */
export const describe = (t: string, d?: string) => {
  let text = (d ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .split(/(?<=\.)\s/)[0]
    .replace(/\.$/, '');

  if (text.length > 48) {
    text = `${text.slice(0, 48).replace(/\s+\S*$/, '')}…`;
  }

  return text ? `${t} — ${text}` : t;
};
