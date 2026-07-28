import { describe, expect, it } from 'bun:test';
import { HttpStatusCode, type HttpStatusName } from './status.js';

describe('HttpStatusCode', () => {
  it('exposes the same name as both a value and a type', () => {
    // Compiles only because `type HttpStatusCode` is the union of the values.
    const code: HttpStatusCode = HttpStatusCode.NOT_FOUND;
    const name: HttpStatusName = 'IM_A_TEAPOT';

    expect(code).toBe(404);
    expect(HttpStatusCode[name]).toBe(418);
  });

  it('is frozen, which an `as const` object alone would not be', () => {
    expect(Object.isFrozen(HttpStatusCode)).toBe(true);
    expect(() => {
      (HttpStatusCode as unknown as { OK: number }).OK = 999;
    }).toThrow(TypeError);
    expect(HttpStatusCode.OK).toBe(200);
  });

  it('holds no reverse mapping — the thing an enum would add', () => {
    expect(Object.keys(HttpStatusCode)).not.toContain('200');
    expect(
      Object.values(HttpStatusCode).every((code) => typeof code === 'number'),
    ).toBe(true);
  });
});
