import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { testClient, type TestClient } from '@dunx/testing';
import { createApp } from './main.js';
import { SelfOrigin } from './landing/self-origin.js';

/** `/api/preferences` in the whole app: security headers, CSRF and `etag` on. */
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

const choose = async (theme: string) => {
  const response = await client.request('api/preferences', {
    method: 'PUT',
    json: { theme },
  });
  await response.text();
  const [header = ''] = response.headers.getSetCookie();
  return { response, header, cookie: header.slice(0, header.indexOf(';')) };
};

const themeWith = async (cookie: string): Promise<unknown> =>
  (await client.json('api/preferences', { headers: { cookie } })).body;

it('signs the chosen theme into an HttpOnly, Secure cookie and reads it back', async () => {
  const { response, header, cookie } = await choose('dark');
  expect(response.status).toBe(200);
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(header).toMatch(
    /^prefs=dark\.[\w-]{43}; Path=\/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax$/,
  );
  expect(await themeWith(cookie)).toEqual({ theme: 'dark' });
});

it('reads an edited or unsigned cookie as the default', async () => {
  const { cookie } = await choose('dark');
  expect(await themeWith(cookie.replace('dark', 'light'))).toEqual({
    theme: 'system',
  });
  expect(await themeWith('prefs=light')).toEqual({ theme: 'system' });
  expect(await themeWith('')).toEqual({ theme: 'system' });
});

it('refuses a theme the schema does not name, and sets nothing', async () => {
  const { response, header } = await choose('neon');
  expect(response.status).toBe(400);
  expect(header).toBe('');
});

it('clears the cookie', async () => {
  const response = await client.request('api/preferences', {
    method: 'DELETE',
  });
  expect(response.status).toBe(204);
  expect(response.headers.getSetCookie()).toEqual([
    'prefs=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
  ]);
});
