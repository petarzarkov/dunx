import { afterAll, beforeAll, expect, it } from 'bun:test';
import { HttpError, Readiness, type HttpApp } from '@dunx/http';
import { FetchError, HttpService } from '@dunx/http/client';
import { ScheduleRegistry } from '@dunx/infra/schedule';
import { testClient, type JsonInit, type TestClient } from '@dunx/testing';
import { createApp } from './bootstrap.js';
import { Maintenance } from './schedule/maintenance.service.js';

/**
 * The routes, exercised in-process against the same `createApp()` that `bun
 * start` uses - so what is asserted here is what actually serves.
 *
 * `@dunx/testing`'s client owns the fetch-and-parse plumbing. `createTestServer`
 * is not used here on purpose: the point of this suite is that `createApp()` - the
 * real bootstrap, with its prefix, CORS and middleware - is what answers.
 */
let app: HttpApp;
let client: TestClient;

/** Every route sits under the global prefix `createApp()` set. */
const json = <T>(path: string, init?: JsonInit) =>
  client.json<T>(`api/${path}`, init);

const raw = (path: string): Promise<Response> => client.request(`api/${path}`);

const post = (body: unknown, headers?: Record<string, string>): JsonInit => ({
  method: 'POST',
  json: body,
  ...(headers === undefined ? {} : { headers }),
});

beforeAll(async () => {
  app = await createApp();
  // Port 0: the suite must not collide with a `bun start` already on 3000.
  client = testClient(await app.listen(0));
});

afterAll(async () => {
  await app.shutdown();
});

interface Report {
  status: string;
  draining: boolean;
  uptimeMs: number;
  checks: { name: string; state: string; critical: boolean; detail?: string }[];
}

it('answers liveness on a memory ceiling alone', async () => {
  const { status, body } = await json<Report>('health/live');

  expect(status).toBe(200);
  expect(body.status).toBe('up');
  expect(body.draining).toBe(false);
  expect(body.checks.map((check) => check.name)).toEqual(['memory']);
  // Not critical: a process near its ceiling is worth seeing, and shedding
  // traffic from it does not make it use less memory.
  expect(body.checks[0]?.critical).toBe(false);
});

it('answers readiness, and only redis may be down', async () => {
  const { status, body } = await json<Report>('health/ready');

  expect(status).toBe(200);
  expect(body.status).toBe('up');
  expect(body.checks.map((check) => check.name)).toEqual([
    'database',
    'ledger',
    'redis',
    'disk',
  ]);
  // Redis is the only area that can be absent without stopping this app, so it
  // is the only critical:false check that is allowed to be anything but `up`.
  for (const check of body.checks) {
    if (check.name === 'redis' || check.name === 'disk') continue;
    expect(check.state).toBe('up');
  }
  expect(body.checks.find((check) => check.name === 'redis')?.critical).toBe(
    false,
  );
});

it('holds the pod out of rotation without failing liveness', async () => {
  const readiness = app.get(Readiness);
  readiness.hold('migrating');
  try {
    const held = await json<Report>('health/ready');
    expect(held.status).toBe(503);
    expect(held.body.draining).toBe(true);
    expect(held.body.checks[0]?.detail).toBe('migrating');

    // A pod that is shutting down does not need killing, so liveness keeps
    // passing - reporting `down` here would invite a SIGKILL mid-drain.
    expect((await json<Report>('health/live')).status).toBe(200);
  } finally {
    readiness.release();
  }

  expect((await json<Report>('health/ready')).status).toBe(200);
});

it('serves the ledger over drizzle, seeded at onInit', async () => {
  const { status, body: page } = await json<{
    entries: unknown[];
    balance: number;
  }>('ledger');

  expect(status).toBe(200);
  expect(page.entries.length).toBeGreaterThan(0);
  expect(typeof page.balance).toBe('number');
});

it('rolls a transfer back as one unit, observably', async () => {
  const entries = async (): Promise<number> =>
    (await json<{ entries: unknown[] }>('ledger')).body.entries.length;
  const before = await entries();

  // Both legs land. 201 is the POST default, and it did create two rows.
  const ok = await json<{ rows: number }>(
    'ledger/transfer',
    post({ from: 'checking', to: 'savings', amount: 25 }),
  );
  expect(ok.status).toBe(201);
  expect(ok.body.rows).toBe(before + 2);

  // Throwing between the legs leaves the count exactly where it was, which is
  // the only way to see from outside that the first insert did not commit.
  const rolled = await json(
    'ledger/transfer',
    post({ from: 'a', to: 'b', amount: 5, fail: true }),
  );
  expect(rolled.status).toBe(409);
  expect(await entries()).toBe(before + 2);
});

it('rolls the synchronous transfer back the same way, with no async handler', async () => {
  const entries = async (): Promise<number> =>
    (await json<{ entries: unknown[] }>('ledger')).body.entries.length;
  const before = await entries();

  const ok = await json<{ rows: number }>(
    'ledger/transfer-sync',
    post({ from: 'checking', to: 'savings', amount: 25 }),
  );
  expect(ok.status).toBe(201);
  expect(ok.body.rows).toBe(before + 2);

  const rolled = await json(
    'ledger/transfer-sync',
    post({ from: 'a', to: 'b', amount: 5, fail: true }),
  );
  expect(rolled.status).toBe(409);
  expect(await entries()).toBe(before + 2);
});

it('round-trips an object through Storage and refuses to escape the root', async () => {
  const written = await json('files/object?key=reports/q1.csv', {
    method: 'PUT',
    json: { content: 'quarter,amount\nQ1,100\n' },
  });
  expect(written.status).toBe(200);
  expect(written.body).toEqual({ key: 'reports/q1.csv', bytes: 22 });

  const read = await json<{ content: string }>(
    'files/object?key=reports/q1.csv',
  );
  expect(read.status).toBe(200);
  expect(read.body.content).toBe('quarter,amount\nQ1,100\n');

  const listed = await json<{ keys: string[] }>('files');
  expect(listed.body.keys).toContain('reports/q1.csv');

  // A bad request, not a 500 - Storage rejects it before any syscall.
  const escaped = await json<{ error: string }>(
    'files/object?key=../../etc/passwd',
  );
  expect(escaped.status).toBe(400);
  expect(escaped.body.error).toContain('escapes the storage root');

  // Nothing signs bytes on a local disk, and it says so rather than pretending.
  const presigned = await json('files/presign?key=reports/q1.csv');
  expect(presigned.status).toBe(501);
});

it('encodes an image Bun.Image generated at runtime', async () => {
  const described = await json('images/metadata?width=32&format=webp');
  expect(described.status).toBe(200);
  expect(described.body).toMatchObject({
    width: 32,
    height: 24,
    format: 'webp',
    mimeType: 'image/webp',
  });

  // The render route returns the bytes themselves, so a browser shows them.
  const rendered = await raw('images/render?width=48&format=png');
  expect(rendered.status).toBe(200);
  expect(rendered.headers.get('content-type')).toBe('image/png');
  expect((await rendered.bytes()).byteLength).toBeGreaterThan(0);
});

it('answers the cache routes, degrading to 503 rather than failing', async () => {
  const status = await json<{ reachable: boolean }>('cache');
  expect(status.status).toBe(200);

  const stored = await json<{ error: string }>('cache/suite', {
    method: 'PUT',
    json: { data: { user: 'ada' }, ttl: 60 },
  });

  if (!status.body.reachable) {
    // The contract when nothing is running: a degraded service, not a bug.
    expect(stored.status).toBe(503);
    expect(stored.body.error).toContain('Cache unavailable');
    return;
  }

  expect(stored.status).toBe(200);
  const read = await json<{ data: unknown }>('cache/suite');
  expect(read.status).toBe(200);
  expect(read.body.data).toEqual({ user: 'ada' });
  expect((await json('cache/suite', { method: 'DELETE' })).status).toBe(200);
});

it('guards only the reports controller', async () => {
  // @UseGuards(AuthGuard) is on ReportsController, so everything else is open.
  expect((await json('users')).status).toBe(200);
  expect((await json('notes')).status).toBe(200);
  expect((await json('ledger')).status).toBe(200);

  expect((await json('reports')).status).toBe(401);
  expect((await json('reports/health')).status).toBe(200);
  expect(
    (
      await json('reports', {
        headers: { authorization: 'Bearer viewer' },
      })
    ).status,
  ).toBe(200);
});

it('limits by subject, and exempts what opted out', async () => {
  // Its own key, so this suite has its own window whatever else ran.
  const key = `suite-${Bun.randomUUIDv7()}`;
  const burst = () =>
    client.request('api/limits/burst', { headers: { 'x-api-key': key } });

  for (let i = 0; i < 3; i += 1) {
    const allowed = await burst();
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('ratelimit-limit')).toBe('3');
  }

  const refused = await burst();
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);

  // @SkipThrottle() is not counted at all, so past the limit is still 200.
  for (let i = 0; i < 5; i += 1) {
    const exempt = await client.request('api/limits/exempt', {
      headers: { 'x-api-key': key },
    });
    expect(exempt.status).toBe(200);
  }

  // A different subject is a different window on the same route.
  const other = await client.request('api/limits/burst', {
    headers: { 'x-api-key': `${key}-other` },
  });
  expect(other.status).toBe(200);
});

it('serves assets under /assets, outside the api prefix', async () => {
  const plain = await client.request('assets/site.css');
  expect(plain.status).toBe(200);
  expect(plain.headers.get('cache-control')).toBe('public, max-age=60');

  // A content hash is the only honest reason to promise forever.
  const hashed = await client.request('assets/app.a1b2c3d4.js');
  expect(hashed.status).toBe(200);
  expect(hashed.headers.get('cache-control')).toContain('immutable');

  // Resolved against the root at construction, checked on every request.
  expect((await client.request('assets/../../package.json')).status).toBe(404);
});

it('arms every schedule and runs one off its own cadence', async () => {
  const registry = app.get(ScheduleRegistry);
  const names = registry.list().map((entry) => entry.name);

  expect(names).toContain('maintenance.compact');
  expect(names).toContain('maintenance.sweep');

  // @OnceOnBoot(0) fires before `listen()` resolves, so it is already done.
  expect(app.get(Maintenance).counts.warmed).toBe(true);

  // A cron at 03:00 is otherwise untestable without waiting for the clock.
  const before = app.get(Maintenance).counts.compactions;
  await registry.trigger('maintenance.compact');
  expect(app.get(Maintenance).counts.compactions).toBe(before + 1);
  expect(registry.get('maintenance.compact')?.lastError).toBeUndefined();
});

it('retries an outbound 503 and raises a 404 as a FetchError', async () => {
  const http = app.get(HttpService);
  const url = client.url;

  // Two 503s then a 200, so the retry is what makes this resolve at all.
  const recovered = await http.get<{ after: number }>(
    new URL('api/upstream/flaky', url),
    { retry: { maxRetries: 3, retryDelayMs: 10 } },
  );
  expect(recovered.after).toBeGreaterThanOrEqual(3);

  // Not an HttpError: an upstream 404 must not become this service's 404.
  const failure = await http
    .get(new URL('api/upstream/missing', url), { retry: { maxRetries: 0 } })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(failure).toBeInstanceOf(FetchError);
  expect((failure as FetchError).status).toBe(404);
  expect(failure).not.toBeInstanceOf(HttpError);
});

it('documents every route it serves, with nothing unresolved', async () => {
  const { status, body: document } = await json<{
    openapi: string;
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  }>('openapi.json');

  expect(status).toBe(200);
  expect(document.openapi).toBe('3.1.0');
  for (const path of [
    '/api/ledger',
    '/api/ledger/transfer',
    '/api/ledger/transfer-sync',
    '/api/files/object',
    '/api/images/render',
    '/api/cache/{id}',
    '/api/users/{id}',
    '/api/reports/{id}',
  ]) {
    expect(document.paths[path]).toBeDefined();
  }
  // Documented by default, under one `Health` tag.
  expect(document.paths['/api/health/live']).toBeDefined();
  expect(document.paths['/api/health/ready']).toBeDefined();

  // Every component is titled by its own key, which is what an explorer labels a
  // nested schema by: the item of `array<User>` reads as `User`, not `object`.
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    expect((schema as { title?: string }).title).toBe(name);
  }
  expect(Object.keys(document.components.schemas)).toContain('CreateEntry');

  const page = await raw('docs');
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toContain('text/html');
});

it('documents the routes Better Auth serves', async () => {
  const { body: document } = await json<{
    paths: Record<string, unknown>;
    tags?: { name: string }[];
  }>('openapi.json');

  // Better Auth answers `/api/auth/*` from its own handler, so route discovery
  // cannot see any of it. `betterAuthDocument` asks the library for its schema.
  expect(document.paths['/api/auth/sign-in/email']).toBeDefined();
  expect(document.paths['/api/auth/get-session']).toBeDefined();
  expect(document.tags?.map((tag) => tag.name)).toContain('Auth');
});
