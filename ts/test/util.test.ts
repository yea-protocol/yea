import { describe, expect, it } from 'vitest';
import { plainCopy } from '../src/util.js';

describe('plainCopy', () => {
  it('copies arrays and plain objects read through a proxy, which structuredClone refuses', () => {
    const v = { a: [1, { b: 'x' }], n: null, u: undefined };
    const copy = plainCopy(new Proxy(v, {}));

    expect(() => structuredClone(new Proxy(v, {}))).toThrow();
    expect(copy).toEqual(v);
    expect(Object.hasOwn(copy, 'u')).toBe(true);
    expect(copy.a).not.toBe(v.a);
    expect(copy.a[1]).not.toBe(v.a[1]);
  });

  it('keeps anything else as it is, and a part that holds itself', () => {
    const at = new Date(0);
    const f = () => 1;
    const loop: Record<string, unknown> = { at, f };

    loop.self = loop;

    const copy = plainCopy(loop);

    expect(copy).not.toBe(loop);
    expect(copy.at).toBe(at);
    expect(copy.f).toBe(f);
    expect(copy.self).toBe(loop);
  });

  it('copies a __proto__ key as its own key, not as the prototype', () => {
    const v: Record<string, unknown> = JSON.parse(
      '{"__proto__": {"polluted": true}}',
    );
    const copy = plainCopy(v);

    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.hasOwn(copy, '__proto__')).toBe(true);
    expect(copy.polluted).toBeUndefined();
  });
});
