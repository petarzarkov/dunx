import { describe, expect, it } from 'bun:test';
import {
  isPlainObject,
  safeEntries,
  safeStringify,
  serializeError,
} from './serialize.js';

describe('isPlainObject', () => {
  it('accepts objects and rejects arrays, null and errors', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Error('x'))).toBe(false);
    expect(isPlainObject('text')).toBe(false);
  });
});

describe('safeStringify', () => {
  it('stringifies what JSON.stringify can', () => {
    expect(safeStringify({ a: 1, b: 'two' })).toBe('{"a":1,"b":"two"}');
  });

  it('reports undefined rather than returning it', () => {
    expect(safeStringify(undefined)).toBe('undefined');
  });

  /** The two inputs that make the plain call throw. */
  it('survives a cycle', () => {
    const node: Record<string, unknown> = { a: 1 };
    node['self'] = node;

    expect(safeStringify(node)).toBe('{"a":1,"self":"[Circular]"}');
  });

  it('survives a BigInt', () => {
    expect(safeStringify({ n: BigInt(9) })).toBe('{"n":"9"}');
  });
});

describe('serializeError', () => {
  it('collapses the stack onto one line', () => {
    const serialized = serializeError(new Error('boom'));

    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('boom');
    expect(serialized.stack).toBeDefined();
    expect(serialized.stack).not.toContain('\n');
  });

  it('omits the stack when there is none', () => {
    const error = new Error('stackless');
    delete error.stack;

    expect(serializeError(error)).toEqual({
      name: 'Error',
      message: 'stackless',
    });
  });

  it('keeps a subclass name', () => {
    class TimeoutError extends Error {
      override readonly name = 'TimeoutError';
    }

    expect(serializeError(new TimeoutError('late')).name).toBe('TimeoutError');
  });
});

describe('safeEntries', () => {
  it('reads own enumerable properties', () => {
    expect(safeEntries({ a: 1, b: 2 })).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('marks a getter that throws instead of propagating', () => {
    const value = {
      ok: 1,
      get boom(): string {
        throw new Error('reading this throws');
      },
    };

    expect(safeEntries(value)).toEqual([
      ['ok', 1],
      ['boom', '[Getter: threw]'],
    ]);
  });
});
