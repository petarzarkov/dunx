import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { createApp } from './main.js';
import { SelfOrigin } from './landing/self-origin.js';

/**
 * `DOCS_GUARDED=true`, which is the only configuration where the explorers are
 * not public. Both of them: `OpenApiModule`'s `authorize` covers `/api/docs` and
 * `/api/openapi.json`, and `ReferenceMiddleware` runs the same `DocsGate` over
 * `/api/reference`. The default is off, so nothing else in the suite sees this.
 *
 * The variable is set here rather than passed as a `source`: `createApp()` is
 * the application, and reaching into its config would test a different one.
 */
let app: HttpApp;
let base = '';
let origin = '';
let cookie = '';

const CREDENTIALS = {
  email: 'docs-gate@example.test',
  password: 'a long enough password',
  name: 'Ada',
};

/** Every path one `DocsGate` decides, across both explorers. */
const GUARDED = [
  'api/openapi.json',
  'api/docs',
  'api/docs/swagger-ui.css',
  'api/reference',
  'api/reference/standalone.js',
] as const;

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/${path}`, { headers, redirect: 'manual' });

beforeAll(async () => {
  process.env['DOCS_GUARDED'] = 'true';
  app = await createApp();
  const url = await app.listen(0);
  app.get(SelfOrigin).set(url);
  base = new URL(url).origin;
  origin = base;

  await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(CREDENTIALS),
  });
  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      email: CREDENTIALS.email,
      password: CREDENTIALS.password,
    }),
  });
  expect(signIn.status).toBe(200);
  cookie = signIn.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');
});

afterAll(async () => {
  delete process.env['DOCS_GUARDED'];
  await app.shutdown();
});

it('refuses every explorer path to a caller with no session', async () => {
  for (const path of GUARDED) {
    const response = await get(path, { accept: 'application/json' });
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
    await response.arrayBuffer();
  }
});

/**
 * The `Response` arm of `Authorize`. A 404 is right for a prober and a dead end
 * for a person, so a navigation is sent to the panel that issues a session.
 */
it('sends a browser to the landing page rather than a 404', async () => {
  const response = await get('api/docs', { accept: 'text/html' });

  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('/#who');
  // The anchor is real, and it is the control that issues a session: a redirect
  // to a fragment nothing answers to is the same dead end in a nicer costume.
  const landing = await get('');
  expect(await landing.text()).toContain('id="who"');
});

it('serves every explorer path to a caller with one', async () => {
  for (const path of GUARDED) {
    const response = await get(path, { cookie });
    expect({ path, status: response.status }).toEqual({ path, status: 200 });
    await response.arrayBuffer();
  }
});

/** The app's own routes are untouched: this gates the documentation, not the API. */
it('leaves the routes the document describes alone', async () => {
  expect((await get('api/health/live')).status).toBe(200);
});
