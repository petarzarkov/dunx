import { describe, expect, it } from 'bun:test';
import { AppError } from '../di/errors.js';
import { backoffDelay } from './backoff.js';
import {
  RetryClassifier,
  TransientRetryClassifier,
  type RetryVerdict,
} from './classifier.js';
import { ResilienceOptions } from './options.js';
import { ResiliencePolicy } from './policy.js';

const policy = (init: ConstructorParameters<typeof ResilienceOptions>[0]) =>
  new ResiliencePolicy(new ResilienceOptions(init));

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
   * to actually vary, and it comes from `crypto.getRandomValues`.
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

describe('RetryClassifier', () => {
  it('refuses to be constructed as a contract', () => {
    // @ts-expect-error - an abstract class cannot be constructed, and the guard
    // is what catches a transpiled caller that tried anyway.
    expect(() => new RetryClassifier()).toThrow(AppError);
  });

  it('retries anything that is not an abort', () => {
    const classifier = new TransientRetryClassifier();
    expect(classifier.classify(new Error('boom'))).toEqual({ retry: true });
    expect(classifier.classify('not an error')).toEqual({ retry: true });
  });

  it('never retries an abort or a timeout', () => {
    const classifier = new TransientRetryClassifier();
    const abort = new Error('gone');
    abort.name = 'AbortError';
    const timeout = new Error('late');
    timeout.name = 'TimeoutError';
    expect(classifier.classify(abort).retry).toBe(false);
    expect(classifier.classify(timeout).retry).toBe(false);
  });
});

describe('ResiliencePolicy.run', () => {
  const flat = { maxRetries: 2, retryDelayMs: 1, backoff: { jitterMs: 0 } };

  it('returns the first success without retrying', async () => {
    let calls = 0;
    const result = await policy({}).run(() => {
      calls += 1;
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries until it succeeds', async () => {
    let calls = 0;
    const result = await policy({ retry: flat }).run(() => {
      calls += 1;
      if (calls < 3) throw new Error('not yet');
      return Promise.resolve(calls);
    });
    expect(result).toBe(3);
  });

  it('stops after maxRetries and rethrows the last error', async () => {
    let calls = 0;
    await expect(
      policy({ retry: flat }).run(() => {
        calls += 1;
        throw new Error(`attempt ${calls}`);
      }),
    ).rejects.toThrow('attempt 3');
    // One attempt plus two retries.
    expect(calls).toBe(3);
  });

  it('reports each attempt, each failure and the success', async () => {
    const attempts: string[] = [];
    const errors: boolean[] = [];
    let successAt = 0;
    let calls = 0;

    await policy({
      retry: {
        ...flat,
        onAttempt: (attempt, isRetry) =>
          attempts.push(`${attempt}${isRetry ? ' (retry)' : ''}`),
        onError: (_error, _attempt, willRetry) => errors.push(willRetry),
        onSuccess: (_result, attempt) => {
          successAt = attempt;
        },
      },
    }).run(() => {
      calls += 1;
      if (calls === 1) throw new Error('first');
      return Promise.resolve('ok');
    });

    expect(attempts).toEqual(['1', '2 (retry)']);
    expect(errors).toEqual([true]);
    expect(successAt).toBe(2);
  });

  it('says a failure will not be retried on the last attempt', async () => {
    const willRetry: boolean[] = [];
    await policy({
      retry: { ...flat, onError: (_e, _a, retry) => willRetry.push(retry) },
    })
      .run(() => Promise.reject(new Error('always')))
      .catch(() => undefined);
    expect(willRetry).toEqual([true, true, false]);
  });
});

describe('the timeout', () => {
  it('aborts the attempt and is not retried', async () => {
    let calls = 0;
    await expect(
      policy({ timeoutMs: 10, retry: { maxRetries: 3, retryDelayMs: 1 } }).run(
        async (signal) => {
          calls += 1;
          await Bun.sleep(40);
          signal.throwIfAborted();
          return 'never';
        },
      ),
    ).rejects.toThrow();
    // An abort spends the budget for the whole call, so no second attempt.
    expect(calls).toBe(1);
  });

  it('leaves the attempt unbounded at 0', async () => {
    const aborted = await policy({}).run(async (signal) => {
      await Bun.sleep(5);
      return signal.aborted;
    });
    expect(aborted).toBe(false);
  });

  it('combines the caller`s own signal with it', async () => {
    const controller = new AbortController();
    let calls = 0;
    const running = policy({
      timeoutMs: 5_000,
      signal: controller.signal,
      retry: { maxRetries: 3, retryDelayMs: 1 },
    }).run(async (signal) => {
      calls += 1;
      await Bun.sleep(20);
      signal.throwIfAborted();
      return 'never';
    });

    controller.abort();
    await expect(running).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('a classifier that asks for a wait', () => {
  class AskingClassifier extends RetryClassifier {
    constructor(private readonly askMs: number) {
      super();
    }

    classify(): RetryVerdict {
      return { retry: true, delayMs: this.askMs };
    }
  }

  it('waits what it asked for rather than the computed backoff', async () => {
    const started = Date.now();
    let calls = 0;
    await policy({
      classifier: new AskingClassifier(0),
      retry: { maxRetries: 1, retryDelayMs: 1000, backoff: { jitterMs: 0 } },
    }).run(() => {
      calls += 1;
      if (calls === 1) throw new Error('once');
      return Promise.resolve('ok');
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('is still capped by the backoff ceiling', async () => {
    const started = Date.now();
    await policy({
      classifier: new AskingClassifier(3_600_000),
      retry: {
        maxRetries: 1,
        retryDelayMs: 1,
        backoff: { maxMs: 20, jitterMs: 0 },
      },
    })
      .run(() => Promise.reject(new Error('always')))
      .catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('the fallback', () => {
  it('answers the call when every attempt failed', async () => {
    const errors: unknown[] = [];
    const result = await policy({
      retry: { maxRetries: 1, retryDelayMs: 1, backoff: { jitterMs: 0 } },
      fallback: (error) => {
        errors.push(error);
        return 'cached';
      },
    }).run<string>(() => Promise.reject(new Error('upstream down')));

    expect(result).toBe('cached');
    expect(errors).toHaveLength(1);
  });

  it('is not reached when an attempt succeeded', async () => {
    let called = false;
    const result = await policy({
      fallback: () => {
        called = true;
        return 'cached';
      },
    }).run(() => Promise.resolve('live'));
    expect(result).toBe('live');
    expect(called).toBe(false);
  });

  it('may await, and may throw instead of answering', async () => {
    await expect(
      policy({
        retry: { maxRetries: 0 },
        fallback: async (error) => {
          await Bun.sleep(1);
          throw new AppError(`no fallback for ${String(error)}`);
        },
      }).run(() => Promise.reject(new Error('gone'))),
    ).rejects.toThrow(AppError);
  });
});
