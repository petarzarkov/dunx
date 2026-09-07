import type { OpClient } from './client.js';

/**
 * What an op needs before its result means anything. `redis` ops answer 503 with
 * nothing at the broker, which is the app degrading rather than failing, so the
 * work floor is only applied to them when the broker is up.
 */
export type ServiceNeed = 'none' | 'redis';

export interface Op {
  readonly name: string;
  /** Relative share of the traffic. */
  readonly weight: number;
  /**
   * The statuses that mean the app **did the work the op asked for**. A 429 is
   * here only where being refused is the behaviour under test.
   */
  readonly expect: ReadonlySet<number>;
  /**
   * A legitimate refusal rather than work: a rate limit, or a route whose service
   * is absent. Counted apart from `expect` and floored, because a run where every
   * op is refused used to report zero failures.
   */
  readonly tolerate: ReadonlySet<number>;
  readonly requires: ServiceNeed;
  run(client: OpClient): Promise<number>;
}

const of = (...codes: readonly number[]): ReadonlySet<number> => new Set(codes);
const NONE: ReadonlySet<number> = new Set<number>();
/** Every route behind the global `ThrottleGuard` may be refused by it. */
const THROTTLED = of(429);

/**
 * The traffic the load run puts through the app.
 *
 * Each op names the statuses that are work and the statuses that are a refusal,
 * separately. The pair is what lets the run tell "the app served 8,000 requests"
 * apart from "the app declined 8,000 requests", which one accept-set per op
 * could not: every op accepting 429 meant a run that was 59% rate-limited
 * reported `0 failed`.
 */
export const OPS: readonly Op[] = [
  {
    name: 'notes.list',
    weight: 8,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/notes'),
  },
  {
    name: 'notes.create',
    weight: 4,
    expect: of(201),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.json('api/notes', { text: 'soak note' }),
  },
  {
    name: 'users.list',
    weight: 6,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/users?limit=5'),
  },
  {
    name: 'users.one',
    weight: 4,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/users/1'),
  },
  {
    name: 'ledger.write',
    weight: 5,
    expect: of(201),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) =>
      c.json('api/ledger', { account: 'soak', amount: 1, memo: 'soak' }),
  },
  {
    name: 'ledger.page',
    weight: 4,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/ledger/page?take=5'),
  },
  {
    name: 'cache.rw',
    weight: 4,
    expect: of(200),
    tolerate: of(429, 503),
    requires: 'redis',
    run: async (c) => {
      const key = `soak-${Math.floor(Math.random() * 64)}`;
      const put = await c.json(
        `api/cache/${key}`,
        { data: { soak: true }, ttl: 60 },
        'PUT',
      );
      if (put !== 200) return put;
      return c.call(`api/cache/${key}`);
    },
  },
  {
    name: 'trace',
    weight: 3,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) =>
      c.call('api/trace', {
        headers: {
          traceparent:
            '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      }),
  },
  /**
   * Liveness tolerates nothing. A 429 here is what the first load run of this
   * app found: `/health/live` behind a global `ThrottleGuard` answers an
   * orchestrator's probe with a rate limit and the pod is killed under load.
   */
  {
    name: 'health.live',
    weight: 2,
    expect: of(200),
    tolerate: NONE,
    requires: 'none',
    run: (c) => c.call('api/health/live'),
  },
  {
    name: 'health.ready',
    weight: 2,
    expect: of(200),
    tolerate: of(503),
    requires: 'none',
    run: (c) => c.call('api/health/ready'),
  },
  {
    name: 'validation.400',
    weight: 3,
    expect: of(400),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.json('api/notes', { text: '' }),
  },
  {
    name: 'unmatched.404',
    weight: 3,
    expect: of(404),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) =>
      c.call(`api/nothing-here-${Math.random().toString(36).slice(2, 8)}`),
  },
  /** Both statuses are the route working: three per minute, then refusals. */
  {
    name: 'throttle.burst',
    weight: 4,
    expect: of(200, 429),
    tolerate: NONE,
    requires: 'none',
    run: (c) => c.call('api/limits/burst'),
  },
  /** The module default rather than a handler's own, which nothing else covers. */
  {
    name: 'throttle.default',
    weight: 2,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/limits/default'),
  },
  {
    name: 'throttle.exempt',
    weight: 1,
    expect: of(200),
    tolerate: NONE,
    requires: 'none',
    run: (c) => c.call('api/limits/exempt'),
  },
  {
    name: 'openapi',
    weight: 1,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/openapi.json'),
  },
  {
    name: 'ws.clean',
    weight: 3,
    expect: of(200),
    tolerate: NONE,
    requires: 'none',
    run: (c) => c.socket('chat', false),
  },
  {
    name: 'ws.abort',
    weight: 3,
    expect: of(200),
    tolerate: NONE,
    requires: 'none',
    run: (c) => c.socket('chat', true),
  },
  {
    name: 'images.render',
    weight: 2,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/images/render?width=32&format=webp'),
  },
  {
    name: 'images.metadata',
    weight: 1,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/images/metadata?width=32'),
  },
  {
    name: 'files.rw',
    weight: 2,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: async (c) => {
      const key = `soak/${Math.floor(Math.random() * 32)}.txt`;
      const q = `key=${encodeURIComponent(key)}`;
      const put = await c.json(
        `api/files/object?${q}`,
        { content: 'soak' },
        'PUT',
      );
      if (put !== 200) return put;
      return c.call(`api/files/object?${q}`);
    },
  },
  {
    name: 'files.list',
    weight: 1,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/files?prefix=soak'),
  },
  {
    name: 'jobs.enqueue',
    weight: 2,
    expect: of(201),
    tolerate: of(429, 503),
    requires: 'redis',
    run: (c) => c.json('api/jobs/thumbnails', { width: 64, format: 'webp' }),
  },
  /** 503 twice per key then 200, by construction: both are the route working. */
  {
    name: 'upstream.flaky',
    weight: 2,
    expect: of(200, 503),
    tolerate: NONE,
    requires: 'none',
    run: (c) => c.call('api/upstream/flaky'),
  },
  {
    name: 'upstream.missing',
    weight: 1,
    expect: of(404),
    tolerate: NONE,
    requires: 'none',
    run: (c) => c.call('api/upstream/missing'),
  },
  {
    name: 'guards.anon',
    weight: 2,
    expect: of(401),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/reports'),
  },
  /**
   * The same route with credentials. Without this the guarded half of the app is
   * only ever measured being refused, so a guard that rejected everyone would
   * pass the load run.
   */
  {
    name: 'guards.auth',
    weight: 2,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) =>
      c.call('api/reports', { headers: { authorization: 'Bearer viewer' } }),
  },
  /**
   * Authenticated and refused: the class-level `@Roles('admin')` rejects
   * `viewer`. Without the header this would be the guard's 401 instead, which is
   * `guards.anon` and a different branch.
   */
  {
    name: 'guards.role',
    weight: 1,
    expect: of(403),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) =>
      c.call('api/reports', {
        method: 'POST',
        headers: {
          authorization: 'Bearer viewer',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'soak' }),
      }),
  },
  {
    name: 'auth.profile',
    weight: 2,
    expect: of(401),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/profile'),
  },
  {
    name: 'wiring',
    weight: 1,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/wiring'),
  },
  {
    name: 'dashboard',
    weight: 1,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/_dunx'),
  },
  {
    name: 'docs',
    weight: 1,
    expect: of(200),
    tolerate: THROTTLED,
    requires: 'none',
    run: (c) => c.call('api/docs'),
  },
];
