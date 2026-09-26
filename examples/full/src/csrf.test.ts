import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { createApp } from './main.js';
import { SelfOrigin } from './landing/self-origin.js';

/**
 * `csrf` from `AppHttpOptions`: a cross-site write from a browser is refused,
 * and the CORS origin is trusted. The suite runs in test mode, where better-auth
 * skips its own origin check, so every 403 here is dunx's.
 */
let app: HttpApp;
let base = '';

beforeAll(async () => {
  app = await createApp();
  base = await app.listen(0);
  app.get(SelfOrigin).set(base);
});

afterAll(async () => {
  await app.shutdown();
});

const signIn = (headers: Record<string, string>): Promise<Response> =>
  fetch(new URL('api/auth/sign-in/email', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'nobody@example.test', password: 'x' }),
  });

it('refuses a cross-site form post to the auth routes', async () => {
  const response = await signIn({
    origin: 'https://evil.test',
    'sec-fetch-site': 'cross-site',
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: 'CROSS_ORIGIN_REQUEST',
    status: 403,
  });
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});

it('lets the page itself, the CORS origin and a script through', async () => {
  const cases = {
    'same-origin': {
      origin: new URL(base).origin,
      'sec-fetch-site': 'same-origin',
    },
    'cors origin': {
      origin: 'https://example.com',
      'sec-fetch-site': 'cross-site',
    },
    'no browser': {},
  };
  for (const [name, headers] of Object.entries(cases)) {
    const response = await signIn(headers);
    await response.text();
    // better-auth answers a wrong password with 401, which is past the check.
    expect([name, response.status]).toEqual([name, 401]);
  }
});

it('never checks a read', async () => {
  const response = await fetch(new URL('api/health/live', base), {
    headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
  });
  await response.text();
  expect(response.status).toBe(200);
});

it('boots with a CORS origin written with a trailing slash, and trusts it', async () => {
  const before = process.env['CORS_ORIGIN'];
  process.env['CORS_ORIGIN'] = 'https://example.com/';
  const slashed = await createApp();
  try {
    const url = await slashed.listen(0);
    const response = await fetch(new URL('api/auth/sign-in/email', url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://example.com',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'x' }),
    });
    await response.text();
    expect(response.status).toBe(401);
  } finally {
    await slashed.shutdown();
    if (before === undefined) delete process.env['CORS_ORIGIN'];
    else process.env['CORS_ORIGIN'] = before;
  }
});

it('reports the three callers the landing page cannot forge', async () => {
  const response = await fetch(new URL('api/demo/csrf', base));
  expect(await response.json()).toEqual([
    {
      secFetchSite: 'cross-site',
      caller: 'a form on another site',
      status: 403,
    },
    { secFetchSite: 'same-origin', caller: 'this page', status: 400 },
    { secFetchSite: null, caller: 'curl, or a server', status: 400 },
  ]);
});
