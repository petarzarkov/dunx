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
  /** What means the app did the work. A 429 only where refusal is the point. */
  readonly expect: ReadonlySet<number>;
  /** A refusal rather than work: a rate limit, or an absent service. Floored. */
  readonly tolerate: ReadonlySet<number>;
  readonly requires: ServiceNeed;
  run(client: OpClient): Promise<number>;
}

const of = (...codes: readonly number[]): ReadonlySet<number> => new Set(codes);
const NONE: ReadonlySet<number> = new Set<number>();
/** Every route behind the global `ThrottleGuard` may be refused by it. */
const THROTTLED = of(429);

/**
 * The traffic the load run puts through the app, each op naming what counts as
 * work and what counts as a refusal.
 * See docs/architecture/tooling.md, "The load run measured the rate limiter".
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
  /** Tolerates nothing: a 429 here is an orchestrator killing the pod. */
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
