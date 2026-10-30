import { afterAll, beforeAll, expect, it } from 'bun:test';
import {
  Bulkhead,
  BulkheadRejectedError,
  CircuitBreaker,
  CircuitOpenError,
  ResilienceOptions,
  ResiliencePolicy,
  type ResilienceOptionsInit,
} from '@dunx/core';
import { HttpRetryClassifier, HttpService } from '@dunx/http/client';
import { createTestServer, type TestServer } from '@dunx/testing';
import { configModule } from './config.js';
import { FLAKY_FAILURES, SLOW_ROUTE_MS } from './upstream/flaky.controller.js';
import { UpstreamModule } from './upstream/upstream.module.js';
import { UpstreamPolicy } from './upstream/upstream.policy.js';

/**
 * `ResiliencePolicy` around the same upstream the client half calls, on its own
 * server so `service.test.ts` stays under the 800-line cap.
 *
 * The client's own budget is 5 s here and the policy's is 150 ms, so which of
 * the two cancelled a call is never ambiguous.
 */
let server: TestServer;

const upstream = (path: string): URL => new URL(path, server.url);

const policy = (): UpstreamPolicy => server.app.get(UpstreamPolicy);
const http = (): HttpService => server.app.get(HttpService);

beforeAll(async () => {
  server = await createTestServer({
    modules: [configModule({ UPSTREAM_TIMEOUT_MS: '5000' }), UpstreamModule],
  });
});

afterAll(async () => {
  await server.close();
});

it('retries through a ResiliencePolicy and falls back on a 404', async () => {
  const key = `policy-suite-${Date.now()}`;

  // The client is told not to retry, so the recovery is the policy's own loop.
  const recovered = await policy().run((signal) =>
    http().get<{ after: number }>(upstream(`upstream/flaky?key=${key}`), {
      retry: { maxRetries: 0 },
      signal,
    }),
  );
  expect(recovered.after).toBe(FLAKY_FAILURES + 1);

  // `HttpRetryClassifier` refuses a 404, so the fallback is what answers.
  const answered = await policy().run((signal) =>
    http().get<{ cached?: boolean }>(upstream('upstream/missing'), {
      retry: { maxRetries: 0 },
      signal,
    }),
  );
  expect(answered.cached).toBe(true);
});

/**
 * The policy's timeout reaches the request only through the signal `run` hands
 * each attempt. With the client given no budget of its own, an operation that
 * drops that signal runs the 300 ms route to completion and answers `done`.
 */
it('cancels a slow call with the budget the policy handed the attempt', async () => {
  const started = Date.now();
  const answered = await policy().run((signal) =>
    http().get<{ done?: true; cached?: boolean }>(upstream('upstream/slow'), {
      retry: { maxRetries: 0 },
      timeoutMs: 0,
      signal,
    }),
  );

  expect(answered.done).toBeUndefined();
  // An abort is never retried, so the fallback answers within one budget.
  expect(answered.cached).toBe(true);
  expect(Date.now() - started).toBeLessThan(SLOW_ROUTE_MS);
});

const perCall = (init: ResilienceOptionsInit): ResiliencePolicy =>
  new ResiliencePolicy(new ResilienceOptions(init));

/**
 * A policy per call, as `HttpService` builds them, so the breaker is the only
 * thing carrying state from one call to the next.
 */
it('opens a shared breaker on 503s and stops sending', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2 });
  const key = `breaker-suite-${Date.now()}`;
  let sent = 0;
  const call = () =>
    perCall({
      breaker,
      retry: { maxRetries: 3, retryDelayMs: 5 },
      classifier: new HttpRetryClassifier(),
    }).run((signal) => {
      sent += 1;
      return http().get(upstream(`upstream/flaky?key=${key}`), {
        retry: { maxRetries: 0 },
        signal,
      });
    });

  await expect(call()).rejects.toBeInstanceOf(CircuitOpenError);
  await expect(call()).rejects.toBeInstanceOf(CircuitOpenError);
  expect(sent).toBe(2);
  expect(breaker.state).toBe('open');
});

it('sheds a call past the bulkhead while the first is in flight', async () => {
  const bulkhead = new Bulkhead({ maxConcurrent: 1 });
  const slow = () =>
    perCall({ bulkhead, retry: { maxRetries: 0 } }).run((signal) =>
      http().get<{ done: true }>(upstream('upstream/slow'), {
        retry: { maxRetries: 0 },
        timeoutMs: 0,
        signal,
      }),
    );

  const first = slow();
  await expect(slow()).rejects.toBeInstanceOf(BulkheadRejectedError);
  expect(await first).toEqual({ done: true });
  expect(bulkhead.active).toBe(0);
});
