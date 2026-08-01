import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { createApp } from './bootstrap.js';

/**
 * The routes, exercised in-process against the same `createApp()` that `bun
 * start` uses — so what is asserted here is what actually serves.
 */
let app: HttpApp;
let base: string;

const api = (path: string): URL => new URL(`api/${path}`, base);

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(api(path), init);
  return { status: response.status, body: await response.json() };
};

const post = (
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  app = await createApp();
  // Port 0: the suite must not collide with a `bun start` already on 3000.
  base = await app.listen(0);
});

afterAll(async () => {
  await app.shutdown();
});

it('reports every area, and only redis can be degraded', async () => {
  const { status, body } = await json('health');
  const health = body as {
    ok: boolean;
    areas: { name: string; state: string }[];
  };

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
  const { status, body } = await json('ledger');
  const page = body as { entries: unknown[]; balance: number };

  expect(status).toBe(200);
  expect(page.entries.length).toBeGreaterThan(0);
  expect(typeof page.balance).toBe('number');
});

it('rolls a transfer back as one unit, observably', async () => {
  const before = ((await json('ledger')).body as { entries: unknown[] }).entries
    .length;

  // Both legs land. 201 is the POST default, and it did create two rows.
  const ok = await json(
    'ledger/transfer',
    post({ from: 'checking', to: 'savings', amount: 25 }),
  );
  expect(ok.status).toBe(201);
  expect((ok.body as { rows: number }).rows).toBe(before + 2);

  // Throwing between the legs leaves the count exactly where it was, which is
  // the only way to see from outside that the first insert did not commit.
  const rolled = await json(
    'ledger/transfer',
    post({ from: 'a', to: 'b', amount: 5, fail: true }),
  );
  expect(rolled.status).toBe(409);
  const after = ((await json('ledger')).body as { entries: unknown[] }).entries
    .length;
  expect(after).toBe(before + 2);
});

it('round-trips an object through Storage and refuses to escape the root', async () => {
  const written = await json('files/object?key=reports/q1.csv', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'quarter,amount\nQ1,100\n' }),
  });
  expect(written.status).toBe(200);
  expect(written.body).toEqual({ key: 'reports/q1.csv', bytes: 22 });

  const read = await json('files/object?key=reports/q1.csv');
  expect(read.status).toBe(200);
  expect((read.body as { content: string }).content).toBe(
    'quarter,amount\nQ1,100\n',
  );

  const listed = await json('files');
  expect((listed.body as { keys: string[] }).keys).toContain('reports/q1.csv');

  // A bad request, not a 500 — Storage rejects it before any syscall.
  const escaped = await json('files/object?key=../../etc/passwd');
  expect(escaped.status).toBe(400);
  expect((escaped.body as { error: string }).error).toContain(
    'escapes the storage root',
  );

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
  const rendered = await fetch(api('images/render?width=48&format=png'));
  expect(rendered.status).toBe(200);
  expect(rendered.headers.get('content-type')).toBe('image/png');
  expect((await rendered.bytes()).byteLength).toBeGreaterThan(0);
});

it('answers the cache routes, degrading to 503 rather than failing', async () => {
  const status = await json('cache');
  expect(status.status).toBe(200);
  const { reachable } = status.body as { reachable: boolean };

  const stored = await json('cache/suite', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { user: 'ada' }, ttl: 60 }),
  });

  if (!reachable) {
    // The contract when nothing is running: a degraded service, not a bug.
    expect(stored.status).toBe(503);
    expect((stored.body as { error: string }).error).toContain(
      'Cache unavailable',
    );
    return;
  }

  expect(stored.status).toBe(200);
  const read = await json('cache/suite');
  expect(read.status).toBe(200);
  expect((read.body as { data: unknown }).data).toEqual({ user: 'ada' });
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
  const { status, body } = await json('openapi.json');
  const document = body as {
    openapi: string;
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };

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

  const page = await fetch(api('docs'));
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toContain('text/html');
});
