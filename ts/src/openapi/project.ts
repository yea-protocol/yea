/** Response projection (the `project` option): keep only the named fields of an upstream reply. */
import { isObjectOrArray, prop } from './json.js';

function pluck(v: unknown, path: string): unknown {
  const [head, ...rest] = path.split('.');

  if (head.endsWith('[]')) {
    const arr = prop(v, head.slice(0, -2));

    if (!Array.isArray(arr)) {
      return null;
    }

    const vals = arr
      .map((x) => (rest.length ? pluck(x, rest.join('.')) : x))
      .filter((x) => x !== null && x !== undefined);

    return vals.join(', ');
  }

  const next = prop(v, head);

  return rest.length ? pluck(next, rest.join('.')) : (next ?? null);
}

const lastSegment = (path: string) => path.slice(path.lastIndexOf('.') + 1);

/** Split a projection entry into [output key, path]: `out=path`, else the path's last name. */
function projection(field: string): [string, string] {
  if (field.includes('=')) {
    const [key, path] = field.split('=');

    return [key, path];
  }

  const named = field.includes('[]') ? field.split('[]')[0] : field;

  return [lastSegment(named), field];
}

export function projectFields(data: unknown, fields: string[]): unknown {
  const one = (o: unknown) =>
    Object.fromEntries(
      fields.map((f) => {
        const [k, p] = projection(f);

        return [k, pluck(o, p)];
      }),
    );

  if (Array.isArray(data)) {
    return data.map(one);
  }

  if (isObjectOrArray(data) && Array.isArray(data.items)) {
    return {
      ...('total_count' in data ? { total: data.total_count } : {}),
      items: data.items.map(one),
    };
  }

  return isObjectOrArray(data) ? one(data) : data;
}
