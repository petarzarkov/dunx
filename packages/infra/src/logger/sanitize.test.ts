import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  captureConsole,
  testConfig,
  testLogger,
  type Capture,
} from './fixture.test.js';
import { resolveLoggerOptions } from './options.js';
import {
  findNestedError,
  sanitizeLogEntry,
  type SanitizeOptions,
} from './sanitize.js';
import type { LogEntry } from './types.js';

describe('sanitization through the logger', () => {
  let capture: Capture;
  let logger: ReturnType<typeof testLogger>;

  beforeEach(() => {
    logger = testLogger(testConfig);
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
  });

  describe('masking', () => {
    it('masks sensitive fields', () => {
      logger.log('Sensitive data test', {
        password: 'secret123',
        token: 'jwt-token',
        normalField: 'visible',
      });

      expect(capture.entry()).toMatchObject({
        password: '[MASKED]',
        token: '[MASKED]',
        normalField: 'visible',
      });
    });

    it('masks nested sensitive fields', () => {
      logger.log('Nested sensitive data', {
        user: { password: 'secret123', profile: { token: 'jwt-token' } },
        public: 'visible',
      });

      expect(capture.entry()).toMatchObject({
        user: { password: '[MASKED]', profile: { token: '[MASKED]' } },
        public: 'visible',
      });
    });

    it('masks sensitive fields inside arrays', () => {
      logger.log('Sent Response', {
        responseBody: [
          {
            id: 'c0d92e74-1328-4f3c-9c2e-28e989bcfb08',
            entityId: null,
            apiKey: '2ea996bc-1a44-41aa-8d61-411e4f26d3c0',
            apiSecret: 'EFE4CCC813C3A909C320BEA2082B8DC2',
            apiPass: 'Supercoolpass123!',
            provider: 'okx',
          },
        ],
      });

      expect(capture.entry()).toMatchObject({
        responseBody: [
          {
            id: 'c0d92e74-1328-4f3c-9c2e-28e989bcfb08',
            provider: 'okx',
            apiKey: '[MASKED]',
            apiSecret: '[MASKED]',
            apiPass: '[MASKED]',
          },
        ],
      });
    });

    it('masks sensitive fields in objects nested under arrays', () => {
      testLogger({ ...testConfig, maxArrayLength: 5 }).log('Complex nested', {
        users: [
          {
            id: 1,
            name: 'John',
            credentials: { password: 'secret123', apiKey: 'key123' },
          },
          {
            id: 2,
            name: 'Jane',
            auth: { token: 'jwt-token', secret: 'secret456' },
          },
        ],
        metadata: { apiSecret: 'global-secret' },
      });

      expect(capture.entry()).toMatchObject({
        users: [
          {
            name: 'John',
            credentials: { password: '[MASKED]', apiKey: '[MASKED]' },
          },
          { name: 'Jane', auth: { token: '[MASKED]', secret: '[MASKED]' } },
        ],
        metadata: { apiSecret: '[MASKED]' },
      });
    });
  });

  describe('JSON-safe conversion', () => {
    it('serializes an Error nested in extra data', () => {
      logger.log('Database operation failed', {
        operation: 'db-query',
        details: {
          query: 'SELECT * FROM users',
          dbError: new Error('Connection refused'),
        },
      });

      expect(capture.entry()).toMatchObject({
        details: {
          dbError: { name: 'Error', message: 'Connection refused' },
        },
      });
    });

    it('handles functions', () => {
      function testFunction(): string {
        return 'test';
      }
      const namedFunction = function namedFunc(): string {
        return 'named';
      };
      const arrowFunction = (): string => 'arrow';

      logger.log('Function test', {
        regular: testFunction,
        named: namedFunction,
        arrow: arrowFunction,
        anonymous: (
          () => (): string =>
            'anon'
        )()(),
      });

      expect(capture.entry()).toMatchObject({
        regular: '[Function: testFunction]',
        named: '[Function: namedFunc]',
        arrow: '[Function: arrowFunction]',
      });
    });

    it('handles BigInt', () => {
      logger.log('BigInt test', { value: BigInt(123456789012345) });

      expect(capture.entry()).toMatchObject({
        value: '[BigInt: 123456789012345]',
      });
    });

    it('handles Symbol', () => {
      logger.log('Symbol test', {
        basic: Symbol('test'),
        global: Symbol.for('globalSymbol'),
      });

      expect(capture.entry()).toMatchObject({
        basic: '[Symbol: Symbol(test)]',
        global: '[Symbol: Symbol(globalSymbol)]',
      });
    });

    it('handles Date', () => {
      logger.log('Date test', { date: new Date('2023-01-01T00:00:00.000Z') });

      expect(capture.entry()).toMatchObject({
        date: '2023-01-01T00:00:00.000Z',
      });
    });

    it('handles RegExp', () => {
      logger.log('RegExp test', { pattern: /test.*pattern/gi });

      expect(capture.entry()).toMatchObject({
        pattern: '[RegExp: /test.*pattern/gi]',
      });
    });

    it('handles mixed problematic types in arrays', () => {
      logger.log('Mixed array test', {
        mixed: [
          'string',
          123,
          function testFunc(): string {
            return 'test';
          },
          BigInt(456),
          Symbol('arraySymbol'),
          new Date('2023-01-01'),
          /pattern/i,
        ],
      });

      expect(capture.entry()).toMatchObject({
        mixed: ['string', '[TRUNCATED: 6 more items]'],
      });
    });

    it('handles objects with non-serializable properties', () => {
      logger.log('Problematic object test', {
        normal: 'string',
        func: (): string => 'test',
        nested: {
          bigint: BigInt(789),
          symbol: Symbol('nested'),
          date: new Date('2023-06-15T12:00:00.000Z'),
        },
      });

      expect(capture.entry()).toMatchObject({
        normal: 'string',
        func: '[Function: func]',
        nested: {
          bigint: '[BigInt: 789]',
          symbol: '[Symbol: Symbol(nested)]',
          date: '2023-06-15T12:00:00.000Z',
        },
      });
    });

    it('truncates arrays at maxArrayLength', () => {
      testLogger({ ...testConfig, maxArrayLength: 3 }).log('Truncation test', {
        array: ['item1', 'item2', 'item3', 'item4', 'item5'],
      });

      expect(capture.entry()).toMatchObject({
        array: ['item1', 'item2', 'item3', '[TRUNCATED: 2 more items]'],
      });
    });

    it('leaves an array within maxArrayLength alone', () => {
      testLogger({ ...testConfig, maxArrayLength: 5 }).log('Short array', {
        array: ['item1', 'item2', 'item3'],
      });

      expect(capture.entry()).toMatchObject({
        array: ['item1', 'item2', 'item3'],
      });
    });
  });
});

const options = resolveLoggerOptions();
// Field by field: `options` is typed as an abstract class, and spreading that
// drops the prototype the type claims it has.
const withOptions = (overrides: Partial<SanitizeOptions>): SanitizeOptions => ({
  maskFields: overrides.maskFields ?? options.maskFields,
  maxArrayLength: overrides.maxArrayLength ?? options.maxArrayLength,
  maxDepth: overrides.maxDepth ?? options.maxDepth,
});

const CIRCULAR = { '[Circular]': 'circular reference detected' };

describe('sanitizeLogEntry', () => {
  it('drops null and undefined but keeps other falsy values', () => {
    expect(
      sanitizeLogEntry(
        { a: null, b: undefined, c: 0, d: '', e: false },
        options,
      ),
    ).toEqual({ c: 0, d: '', e: false });
  });

  it('masks case-insensitively, on any substring of the key', () => {
    expect(
      sanitizeLogEntry(
        {
          xApiKeyHeader: 'k',
          AUTHORIZATION: 'Bearer x',
          nested: { 'set-cookie': 'sid=1' },
        },
        options,
      ),
    ).toEqual({
      xApiKeyHeader: '[MASKED]',
      AUTHORIZATION: '[MASKED]',
      nested: { 'set-cookie': '[MASKED]' },
    });
  });

  /**
   * The reason `seen` is a path rather than a permanent visited set. Reaching one
   * object through two keys is sharing, not a cycle, and reporting the second
   * one as circular loses data that was perfectly serializable.
   */
  it('serializes a value reachable twice, both times', () => {
    const shared = { id: 1 };

    expect(sanitizeLogEntry({ left: shared, right: shared }, options)).toEqual({
      left: { id: 1 },
      right: { id: 1 },
    });
  });

  it('reports a real cycle instead of following it', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node['self'] = node;

    expect(sanitizeLogEntry({ node }, options)).toEqual({
      node: { name: 'root', self: CIRCULAR },
    });
  });

  it('reports a cycle back to the entry itself', () => {
    const entry: LogEntry = { message: 'hi' };
    entry['entry'] = entry;

    expect(sanitizeLogEntry(entry, options)).toEqual({
      message: 'hi',
      entry: CIRCULAR,
    });
  });

  /** An array holding itself: unbounded recursion if arrays are not tracked. */
  it('reports a cycle through an array', () => {
    const list: unknown[] = ['a'];
    list.push(list);

    expect(sanitizeLogEntry({ list }, options)).toEqual({
      list: ['a', CIRCULAR],
    });
  });

  it('stops at maxDepth', () => {
    const nest = (levels: number): Record<string, unknown> => {
      let node: Record<string, unknown> = { leaf: true };
      for (let index = 0; index < levels; index += 1) node = { next: node };
      return node;
    };

    expect(
      sanitizeLogEntry({ root: nest(3) }, withOptions({ maxDepth: 2 })),
    ).toEqual({
      root: { next: { next: '[TRUNCATED: max depth 2]' } },
    });
  });

  /** A cycle is caught by reference; depth is what saves an acyclic chain. */
  it('survives a structure nested thousands of levels deep', () => {
    let node: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 10_000; index += 1) node = { next: node };

    expect(() => sanitizeLogEntry({ node }, options)).not.toThrow();
  });

  it('keeps Map entries, masked by key', () => {
    const map = new Map<unknown, unknown>([
      ['password', 'hunter2'],
      ['id', 7],
      [1, 'one'],
    ]);

    expect(sanitizeLogEntry({ map }, options)).toEqual({
      map: {
        '[Map]': [
          ['password', '[MASKED]'],
          ['id', 7],
          [1, 'one'],
        ],
      },
    });
  });

  it('truncates a Map at maxArrayLength', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);

    expect(
      sanitizeLogEntry({ map }, withOptions({ maxArrayLength: 1 })),
    ).toEqual({
      map: { '[Map]': [['a', 1], '[TRUNCATED: 2 more entries]'] },
    });
  });

  it('keeps Set entries', () => {
    expect(sanitizeLogEntry({ tags: new Set(['a', 'b']) }, options)).toEqual({
      tags: { '[Set]': ['a', 'b'] },
    });
  });

  it('describes an invalid Date instead of throwing', () => {
    expect(sanitizeLogEntry({ when: new Date('nope') }, options)).toEqual({
      when: '[Date: Invalid Date]',
    });
  });

  it('reduces a binary payload to its byte length', () => {
    expect(
      sanitizeLogEntry(
        {
          bytes: new Uint8Array([1, 2, 3]),
          buffer: new ArrayBuffer(8),
          blob: new Blob(['abc'], { type: 'text/plain' }),
          file: new File(['abc'], 'a.txt', { type: 'text/plain' }),
        },
        options,
      ),
    ).toEqual({
      bytes: '[Uint8Array: 3 bytes]',
      buffer: '[ArrayBuffer: 8 bytes]',
      // Bun appends the charset to a text Blob's type; a plain Blob has a `name`
      // key holding `undefined`, so it must not be described as a File.
      blob: '[Blob: 3 bytes, text/plain;charset=utf-8]',
      file: '[File: a.txt (3 bytes, text/plain;charset=utf-8)]',
    });
  });

  it('describes FormData entries', () => {
    const form = new FormData();
    form.set('name', 'ada');
    form.set('avatar', new File(['abc'], 'a.png', { type: 'image/png' }));

    expect(sanitizeLogEntry({ form }, options)).toEqual({
      form: {
        '[FormData]': {
          name: 'ada',
          avatar: '[File: a.png (3 bytes, image/png)]',
        },
      },
    });
  });

  it('marks a getter that throws rather than failing the log call', () => {
    const value = {
      ok: 1,
      get boom(): string {
        throw new Error('reading this throws');
      },
    };

    expect(sanitizeLogEntry({ value }, options)).toEqual({
      value: { ok: 1, boom: '[Getter: threw]' },
    });
  });

  /** `JSON.stringify` ignores symbol keys; so does this, deliberately. */
  it('drops symbol-keyed properties', () => {
    const entry: LogEntry = { visible: 1 };
    Object.assign(entry, { [Symbol('secret')]: 'value' });

    expect(sanitizeLogEntry(entry, options)).toEqual({ visible: 1 });
  });

  it('collapses a stack onto one line', () => {
    const error = new Error('boom');
    const cleaned = sanitizeLogEntry({ error }, options);
    const serialized = cleaned['error'] as { stack: string };

    expect(serialized.stack).not.toContain('\n');
  });
});

describe('findNestedError', () => {
  it('finds an error nested through arrays and objects', () => {
    const error = new Error('deep');

    expect(findNestedError({ a: [{ b: { c: [error] } }] })).toBe(error);
  });

  it('returns null when there is none', () => {
    expect(findNestedError({ a: 1, b: { c: 'error' } })).toBeNull();
  });

  it('terminates on a cycle', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;

    expect(findNestedError(cyclic)).toBeNull();
  });

  it('survives a getter that throws', () => {
    const value = {
      get boom(): string {
        throw new Error('reading this throws');
      },
    };

    expect(findNestedError(value)).toBeNull();
  });
});
