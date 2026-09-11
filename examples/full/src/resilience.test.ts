import { afterAll, beforeAll, expect, it } from 'bun:test';
import { HttpService } from '@dunx/http/client';
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
