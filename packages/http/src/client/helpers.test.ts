import { describe, expect, it } from 'bun:test';
import { isJsonBody, isPlainObject, safeStringify } from './json.js';
import {
  backoffDelay,
  executeWithRetry,
  isRetryableStatus,
  retryAfterMs,
} from './retry.js';
import { FetchError, FetchTransportError } from './errors.js';

describe('safeStringify', () => {
  it('replaces a cycle rather than throwing', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;
    expect(safeStringify(node)).toBe('{"name":"a","self":"[Circular]"}');
  });

  it('is unchanged from JSON.stringify for an acyclic value', () => {
    const value = { a: 1, b: [1, 2], c: { d: null } };
    expect(safeStringify(value)).toBe(JSON.stringify(value));
  });
});

describe('isPlainObject', () => {
  it('accepts an object literal and a null-prototype object', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(JSON.parse('{"a":1}'))).toBe(true);
  });

  /** The reference answered `true` for a Date and every class instance. */
  it('rejects anything with its own prototype', () => {
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new Error('x'))).toBe(false);
    expect(isPlainObject(class {})).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('a')).toBe(false);
  });
});

describe('isJsonBody', () => {
  it('routes a BodyInit straight to fetch', () => {
    expect(isJsonBody(new FormData())).toBe(false);
    expect(isJsonBody(new URLSearchParams())).toBe(false);
    expect(isJsonBody(new Blob(['a']))).toBe(false);
    expect(isJsonBody(new ArrayBuffer(2))).toBe(false);
    expect(isJsonBody(new Uint8Array(2))).toBe(false);
    expect(isJsonBody('already a string')).toBe(false);
  });

  /** A Date is not a plain object but is JSON-encodable: different questions. */
  it('JSON-encodes everything else, Date and class instances included', () => {
    expect(isJsonBody({ a: 1 })).toBe(true);
    expect(isJsonBody([1, 2])).toBe(true);
    expect(isJsonBody(new Date())).toBe(true);
    expect(isJsonBody(42)).toBe(true);
  });

  it('treats nothing as no body', () => {
    expect(isJsonBody(undefined)).toBe(false);
    expect(isJsonBody(null)).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and stays under the ceiling', () => {
    const flat = { jitterMs: 0, maxMs: 30_000 };
    expect(backoffDelay(0, { baseMs: 100, ...flat })).toBe(100);
    expect(backoffDelay(1, { baseMs: 100, ...flat })).toBe(200);
    expect(backoffDelay(4, { baseMs: 100, ...flat })).toBe(1600);
    expect(backoffDelay(30, { baseMs: 100, ...flat })).toBe(30_000);
  });

  /**
   * The jitter is what decorrelates a fleet of clients retrying together, so it has
   * to actually vary - and it comes from `crypto.getRandomValues`, not `Math.random`.
   */
  it('adds a bounded, varying jitter', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      const delay = backoffDelay(0, { baseMs: 100, jitterMs: 1000 });
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThan(1100);
      seen.add(delay);
    }
    expect(seen.size).toBeGreaterThan(30);
  });
});

describe('retryAfterMs', () => {
  it('reads a delay in seconds', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }))).toBe(2000);
    expect(retryAfterMs(new Headers({ 'retry-after': '0' }))).toBe(0);
  });

  /** RFC 9110 allows an HTTP date, and CDNs send them. */
  it('reads an HTTP date, relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const at = new Date(now + 5000).toUTCString();
    expect(retryAfterMs(new Headers({ 'retry-after': at }), now)).toBe(5000);
  });

  it('never returns a negative wait for a date in the past', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const past = new Date(now - 60_000).toUTCString();
    expect(retryAfterMs(new Headers({ 'retry-after': past }), now)).toBe(0);
  });

  it('is undefined when absent or unparseable', () => {
    expect(retryAfterMs(new Headers())).toBeUndefined();
    expect(
      retryAfterMs(new Headers({ 'retry-after': 'soon' })),
    ).toBeUndefined();
  });
});

describe('isRetryableStatus', () => {
  it('retries a server failure, a timeout and a rate limit', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
  });

  /**
   * Narrower than the reference, which also retried 409 and 422. Both are the
   * server rejecting the request; sending it again unchanged gets the same answer.
   */
  it('does not retry a request the server rejected', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe('executeWithRetry', () => {
  const fetchError = (
    status: number,
    headers: Record<string, string> = {},
  ): FetchError =>
    new FetchError(status, 'x', undefined, {
      method: 'GET',
      url: 'http://x/',
      headers: new Headers(headers),
    });

  it('returns the first success without retrying', async () => {
    let calls = 0;
    const result = await executeWithRetry(() => {
      calls += 1;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('stops after maxRetries and rethrows the last error', async () => {
    let calls = 0;
    const failing = (): never => {
      calls += 1;
      throw fetchError(500);
    };
    await expect(
      executeWithRetry(failing, {
        maxRetries: 2,
        retryDelayMs: 1,
        backoff: { jitterMs: 0 },
      }),
    ).rejects.toBeInstanceOf(FetchError);
    // One attempt plus two retries.
    expect(calls).toBe(3);
  });

  it('does not retry a status the policy rejects', async () => {
    let calls = 0;
    await executeWithRetry(
      () => {
        calls += 1;
        throw fetchError(400);
      },
      { maxRetries: 5, retryDelayMs: 1 },
    ).catch(() => undefined);
    expect(calls).toBe(1);
  });

  /** An abort means the call's budget is spent; retrying spends it again. */
  it('never retries an abort', async () => {
    let calls = 0;
    await executeWithRetry(
      () => {
        calls += 1;
        throw new FetchTransportError(
          { method: 'GET', url: 'http://x/' },
          true,
        );
      },
      { maxRetries: 5, retryDelayMs: 1 },
    ).catch(() => undefined);
    expect(calls).toBe(1);
  });

  it('retries a transport failure that was not an abort', async () => {
    let calls = 0;
    await executeWithRetry(
      () => {
        calls += 1;
        throw new FetchTransportError(
          { method: 'GET', url: 'http://x/' },
          false,
        );
      },
      { maxRetries: 2, retryDelayMs: 1, backoff: { jitterMs: 0 } },
    ).catch(() => undefined);
    expect(calls).toBe(3);
  });

  it('waits the Retry-After rather than the computed backoff', async () => {
    const started = Date.now();
    let calls = 0;
    await executeWithRetry(
      () => {
        calls += 1;
        if (calls === 1) throw fetchError(429, { 'retry-after': '0' });
        return 'ok';
      },
      // A backoff that would take a second, overridden by a header asking for none.
      { maxRetries: 1, retryDelayMs: 1000, backoff: { jitterMs: 0 } },
    );
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('caps a Retry-After at the backoff ceiling', async () => {
    const started = Date.now();
    await executeWithRetry(
      () => {
        throw fetchError(429, { 'retry-after': '3600' });
      },
      { maxRetries: 1, retryDelayMs: 1, backoff: { maxMs: 20, jitterMs: 0 } },
    ).catch(() => undefined);
    // An upstream asking for an hour must not park the handler for an hour.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('can be told to ignore Retry-After', async () => {
    const waited: number[] = [];
    await executeWithRetry(
      () => {
        throw fetchError(429, { 'retry-after': '3600' });
      },
      {
        maxRetries: 1,
        retryDelayMs: 1,
        backoff: { jitterMs: 0 },
        respectRetryAfter: false,
        onError: () => waited.push(Date.now()),
      },
    ).catch(() => undefined);
    expect(waited).toHaveLength(2);
  });
});
