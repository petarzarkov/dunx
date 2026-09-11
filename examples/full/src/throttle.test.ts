import { afterAll, beforeAll, expect, it } from 'bun:test';
import { ThrottleGuard } from '@dunx/http';
import { createTestServer, type TestServer } from '@dunx/testing';
import { configModule } from './config.js';
import { LimitsModule } from './throttle/throttle.module.js';

/**
 * The rate limiter against a budget small enough to exhaust.
 *
 * The load run cannot answer these: it raises `THROTTLE_LIMIT` so the app rather
 * than the limiter is what it measures, and `/limits/burst` returning 200 for
 * every call would still read as the route working. So the policy is asserted
 * here, where the budget is five and the window is a minute.
 *
 * `source` rather than the process environment, which is what keeps this
 * independent of whatever `bun test` was launched with. Leaving `REDIS_URL` out
 * of it is deliberate too: `ThrottleModule`'s factory probes the cache and picks
 * `MemoryThrottleStore` when nothing answers, so the counter is per process and
 * the run does not depend on a broker.
 */
const LIMIT = 5;

let server: TestServer;
/** The `subject` reads `x-api-key` first, so a fresh one is a fresh budget. */
let caller = 0;
const asNewCaller = (): Record<string, string> => {
  caller += 1;
  return { 'x-api-key': `throttle-test-${caller}` };
};

const hammer = async (
  path: string,
  times: number,
  headers: Record<string, string>,
): Promise<number[]> => {
  const seen: number[] = [];
  for (let i = 0; i < times; i += 1) {
    seen.push((await server.request(path, { headers })).status);
  }
  return seen;
};

beforeAll(async () => {
  server = await createTestServer({
    modules: [
      configModule({
        THROTTLE_LIMIT: String(LIMIT),
        THROTTLE_WINDOW_SECONDS: '60',
      }),
      LimitsModule,
    ],
    middleware: [ThrottleGuard],
  });
});

afterAll(async () => {
  await server.app.shutdown();
});

it('spends the module default, then refuses', async () => {
  const seen = await hammer('limits/default', LIMIT + 2, asNewCaller());

  expect(seen.slice(0, LIMIT)).toEqual(Array<number>(LIMIT).fill(200));
  expect(seen.slice(LIMIT)).toEqual([429, 429]);
});

it("lets a handler's own @Throttle win over the module default", async () => {
  // Three per minute, under the module's five: the handler decides.
  const seen = await hammer('limits/burst', 5, asNewCaller());

  expect(seen).toEqual([200, 200, 200, 429, 429]);
});

it('never counts a @SkipThrottle() route', async () => {
  const seen = await hammer('limits/exempt', LIMIT * 3, asNewCaller());

  expect(seen.every((status) => status === 200)).toBe(true);
});

it('counts each subject apart', async () => {
  const first = asNewCaller();
  expect(await hammer('limits/default', LIMIT, first)).toEqual(
    Array<number>(LIMIT).fill(200),
  );
  expect(
    (await server.request('limits/default', { headers: first })).status,
  ).toBe(429);

  // A different `x-api-key` is a different subject, so it starts at full budget.
  const second = asNewCaller();
  expect(
    (await server.request('limits/default', { headers: second })).status,
  ).toBe(200);
});

it('counts each route apart', async () => {
  const headers = asNewCaller();
  await hammer('limits/default', LIMIT + 1, headers);

  // `/burst` has its own counter, so exhausting `/default` did not spend it.
  expect((await server.request('limits/burst', { headers })).status).toBe(200);
});

it('describes the refusal in headers a client can retry on', async () => {
  const headers = asNewCaller();
  await hammer('limits/default', LIMIT, headers);
  const refused = await server.request('limits/default', { headers });

  expect(refused.status).toBe(429);
  expect(refused.headers.get('ratelimit-limit')).toBe(String(LIMIT));
  expect(refused.headers.get('ratelimit-remaining')).toBe('0');
  const retryAfter = Number(refused.headers.get('retry-after'));
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(60);
});

it('takes the app error shape rather than a bare status', async () => {
  const headers = asNewCaller();
  await hammer('limits/default', LIMIT, headers);
  const { status, body } = await server.json<{ error: string; status: number }>(
    'limits/default',
    { headers },
  );

  expect(status).toBe(429);
  expect(body.status).toBe(429);
  expect(body.error).toContain(String(LIMIT));
});

it('marks a counted route in the headers of a response it allowed', async () => {
  const allowed = await server.request('limits/default', {
    headers: asNewCaller(),
  });

  expect(allowed.status).toBe(200);
  expect(allowed.headers.get('ratelimit-limit')).toBe(String(LIMIT));
  expect(allowed.headers.get('ratelimit-remaining')).toBe(String(LIMIT - 1));
});

it('leaves no rate-limit headers on a route it never counts', async () => {
  const exempt = await server.request('limits/exempt', {
    headers: asNewCaller(),
  });

  expect(exempt.status).toBe(200);
  // The cheap way to tell "exempt" from "counted but not yet exhausted": an
  // exhausted budget is one status, an uncounted route is no headers at all.
  expect(exempt.headers.get('ratelimit-limit')).toBeNull();
  expect(exempt.headers.get('ratelimit-remaining')).toBeNull();
});
