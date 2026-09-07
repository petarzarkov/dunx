import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { testClient, type TestClient } from '@dunx/testing';
import { createApp } from './main.js';

/**
 * The operations mount, whose only coverage was the tour's exit code and two
 * assertions on log lines.
 *
 * The redaction test is the one that matters: `reveal` is an opt-in allow-list
 * and everything else is masked, so a value leaking into the config panel is a
 * secret on an operator's screen. `AUTH_SECRET` is the canary because the
 * example has one with a known value.
 *
 * `authorize` is **not** covered, because this example deliberately mounts
 * without one so `bun start` is explorable (`dashboard/dashboard.module.ts`).
 * The 404-for-a-stranger behaviour is asserted in `@dunx/dashboard`'s own suite.
 */
let app: HttpApp;
let client: TestClient;

const MOUNT = 'api/_dunx';
/** `config.ts` defaults it, so the suite knows exactly what must not appear. */
const SECRET = 'dunx-full-example-development-secret-not-for-production';

beforeAll(async () => {
  app = await createApp();
  client = testClient(await app.listen(0));
});

afterAll(async () => {
  await app.shutdown();
});

it('serves the page at the mount', async () => {
  const response = await client.request(MOUNT);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(await response.text()).toContain('<html');
});

it('serves the page for a path under the mount, so a reload survives', async () => {
  const response = await client.request(`${MOUNT}/routes`);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
});

it('reports the routes, gateways and providers it discovered', async () => {
  const { status, body } = await client.json<{
    routes: { method: string; path: string }[];
    providers: unknown[];
    modules: unknown[];
  }>(`${MOUNT}/api/snapshot`);

  expect(status).toBe(200);
  expect(body.routes.length).toBeGreaterThan(20);
  expect(body.providers.length).toBeGreaterThan(0);
  expect(body.modules.length).toBeGreaterThan(0);
  // The paths here are the discovered ones, **without** the global prefix the
  // server answers on: this is `/notes`, and the URL that serves it is
  // `/api/notes`.
  expect(body.routes.some((route) => route.path === '/notes')).toBe(true);
});

it('redacts every config value outside the reveal list', async () => {
  const response = await client.request(`${MOUNT}/api/snapshot`);
  const text = await response.text();

  // The whole payload, not one field: a secret is a leak wherever it surfaces.
  expect(text).not.toContain(SECRET);
  // What `reveal` does allow, so the test would fail if the panel had gone blank
  // rather than being correctly masked.
  expect(text).toContain('dunx-full');
});

it('reports http and db statistics, both configured', async () => {
  const { status, body } = await client.json<{
    http: { configured: boolean };
    db: { configured: boolean };
  }>(`${MOUNT}/api/stats`);

  expect(status).toBe(200);
  // `metrics: true` on `HttpFactory.create` and on `DbModule` is what fills these.
  expect(body.http.configured).toBe(true);
  expect(body.db.configured).toBe(true);
});

it('reports the runtime', async () => {
  const { status, body } = await client.json<{ uptimeMs: number }>(
    `${MOUNT}/api/runtime`,
  );

  expect(status).toBe(200);
  expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
});

it('names the queues without opening a connection to them', async () => {
  const { status, body } = await client.json<{ queues: string[] }>(
    `${MOUNT}/api/queues`,
  );

  expect(status).toBe(200);
  expect(body.queues).toContain('thumbnails');
});

it('reports whether redis is configured', async () => {
  const { status } = await client.json(`${MOUNT}/api/redis`);

  expect(status).toBe(200);
});

it('refuses a verb the mount does not answer', async () => {
  const { status } = await client.json<{ error: string }>(
    `${MOUNT}/api/snapshot`,
    { method: 'POST' },
  );

  expect(status).toBe(405);
});

it('answers 404 for a JSON endpoint it does not have', async () => {
  const { status } = await client.json<{ error: string }>(
    `${MOUNT}/api/not-a-panel`,
  );

  expect(status).toBe(404);
});
