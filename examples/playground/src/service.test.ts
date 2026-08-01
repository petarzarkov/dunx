import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { testClient, type JsonInit, type TestClient } from '@dunx/testing';
import { createApp } from './bootstrap.js';

/**
 * The routes, exercised in-process against the same `createApp()` that `bun
 * start` uses — so what is asserted here is what actually serves.
 *
 * `@dunx/testing`'s client owns the fetch-and-parse plumbing. `createTestServer`
 * is not used here on purpose: the point of this suite is that `createApp()` — the
 * real bootstrap, with its prefix, CORS and middleware — is what answers.
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

it('reports every area, and only redis can be degraded', async () => {
  const { status, body: health } = await json<{
    ok: boolean;
    areas: { name: string; state: string }[];
  }>('health');

  expect(status).toBe(200);
  expect(health.ok).toBe(true);
  expect(health.areas.map((area) => area.name)).toEqual([
    '@dunx/infra/db',
    '@dunx/infra/files',
    '@dunx/infra/images',
    '@dunx/infra/redis',
  ]);
  for (const area of health.areas) {
    if (area.name === '@dunx/infra/redis') continue;
    expect(area.state).toBe('live');
  }
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

  // A bad request, not a 500 — Storage rejects it before any syscall.
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

it('documents every route it serves, with nothing unresolved', async () => {
  const { status, body: document } = await json<{
    openapi: string;
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  }>('openapi.json');

  expect(status).toBe(200);
  expect(document.openapi).toBe('3.1.0');
  for (const path of [
    '/api/health',
    '/api/ledger',
    '/api/ledger/transfer',
    '/api/files/object',
    '/api/images/render',
    '/api/cache/{id}',
    '/api/users/{id}',
    '/api/reports/{id}',
  ]) {
    expect(document.paths[path]).toBeDefined();
  }
  expect(Object.keys(document.components.schemas)).toContain('CreateEntry');

  const page = await raw('docs');
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toContain('text/html');
});
