import { afterAll, beforeAll, expect, it } from 'bun:test';
import { STRICT_CSP, type HttpApp } from '@dunx/http';
import { testClient, type TestClient } from '@dunx/testing';
import { createApp } from './main.js';
import { SelfOrigin } from './landing/self-origin.js';

/**
 * `securityHeaders` in `main.ts`: one policy for the app, and a page that boots
 * from an inline script sending its own, which the app's leaves alone.
 */
let app: HttpApp;
let client: TestClient;

const APP_POLICY = `${STRICT_CSP}; img-src 'self' data:`;

beforeAll(async () => {
  app = await createApp();
  const url = await app.listen(0);
  app.get(SelfOrigin).set(url);
  client = testClient(url);
});

afterAll(async () => {
  await app.shutdown();
});

it('stamps a route, the landing page and the 404 with the app policy', async () => {
  for (const path of ['api/health/live', '', 'api/no-such-route']) {
    const response = await client.request(path);
    await response.text();
    expect([path, response.headers.get('content-security-policy')]).toEqual([
      path,
      APP_POLICY,
    ]);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('strict-transport-security')).toContain(
      'max-age=',
    );
  }
});

it('lets each explorer and the dashboard admit its own boot script', async () => {
  for (const path of ['api/docs', 'api/reference', 'api/dashboard']) {
    const response = await client.request(path);
    await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toStartWith(
      "script-src 'self' 'sha256-",
    );
  }
});

it('keeps the policy the email preview route set for itself', async () => {
  const response = await client.request('api/email/preview');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-security-policy')).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; img-src * data:",
  );
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});
