import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { testClient, type TestClient } from '@dunx/testing';
import { createApp } from './main.js';
import { SelfOrigin } from './landing/self-origin.js';

/** `etag: true` in `main.ts`, under the app's compression and security headers. */
let app: HttpApp;
let client: TestClient;

beforeAll(async () => {
  app = await createApp();
  const url = await app.listen(0);
  app.get(SelfOrigin).set(url);
  client = testClient(url);
});

afterAll(async () => {
  await app.shutdown();
});

it('tags a returned value and answers 304 to the tag', async () => {
  const first = await client.request('api/colors');
  expect(first.status).toBe(200);
  await first.text();
  const etag = first.headers.get('etag');
  expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);

  const again = await client.request('api/colors', {
    headers: { 'if-none-match': etag! },
  });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe('');
  expect(again.headers.get('etag')).toBe(etag);
  expect(again.headers.get('vary')).toBe(first.headers.get('vary'));
  expect(again.headers.get('x-frame-options')).toBe('DENY');
});

it('serves the body again once the tag is stale', async () => {
  const response = await client.request('api/v2/swatches', {
    headers: { 'if-none-match': 'W/"0000000000000000"' },
  });
  expect(response.status).toBe(200);
  expect(((await response.json()) as unknown[]).length).toBeGreaterThan(0);
});

it('answers the OpenAPI document with its own tag, weakened when encoded', async () => {
  const identity = await client.request('api/openapi.json', {
    headers: { 'accept-encoding': 'identity' },
  });
  await identity.text();
  expect(identity.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/);

  const first = await client.request('api/openapi.json', {
    headers: { 'accept-encoding': 'gzip' },
  });
  await first.text();
  const etag = first.headers.get('etag');
  expect(etag).toBe(`W/${identity.headers.get('etag')}`);

  const again = await client.request('api/openapi.json', {
    headers: { 'accept-encoding': 'gzip', 'if-none-match': etag! },
  });
  expect(again.status).toBe(304);
  expect(again.headers.get('etag')).toBe(etag);
});
