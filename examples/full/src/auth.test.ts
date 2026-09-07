import { afterAll, beforeAll, expect, it } from 'bun:test';
import { Auth } from '@dunx/auth';
import type { HttpApp } from '@dunx/http';
import { SyncDatabase } from '@dunx/infra/db';
import { eq } from 'drizzle-orm';
import type * as schema from './database/schema.js';
import { user } from './database/schema.js';
import { createApp } from './main.js';

/**
 * better-auth mounted, and `SessionGuard` in front of `/api/profile`.
 *
 * `auth.demo.ts` walks this same flow during the tour and logs each status;
 * nothing asserted any of it, so the whole authenticated half of the example was
 * covered by an exit code. Every credential here is minted by the suite against
 * an in-memory database, so nothing carries between runs.
 */
let app: HttpApp;
let base = '';
/** What better-auth checks a state-changing request's `Origin` against. */
let origin = '';

const CREDENTIALS = {
  email: 'grace@example.test',
  password: 'a long enough password',
  name: 'Grace',
};

const authPost = (
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${base}/api/auth/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...headers },
    body: JSON.stringify(body),
  });

const profile = (
  headers: Record<string, string> = {},
  path = '',
): Promise<Response> => fetch(`${base}/api/profile${path}`, { headers });

/** The `bearer` plugin returns a token in a header; the cookie is the other half. */
const credentialsFrom = (
  response: Response,
): { token: string; cookie: string } => ({
  token: response.headers.get('set-auth-token') ?? '',
  cookie: response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; '),
});

let session: { token: string; cookie: string } = { token: '', cookie: '' };

beforeAll(async () => {
  app = await createApp();
  base = new URL(await app.listen(0)).origin;
  // The server is on port 0, so its own origin is not what better-auth trusts.
  origin = (await app.get(Auth).$context).baseURL;

  expect((await authPost('sign-up/email', CREDENTIALS)).status).toBe(200);
  const signIn = await authPost('sign-in/email', {
    email: CREDENTIALS.email,
    password: CREDENTIALS.password,
  });
  expect(signIn.status).toBe(200);
  session = credentialsFrom(signIn);
});

afterAll(async () => {
  await app.shutdown();
});

it('mints a session cookie and a bearer token at sign-in', () => {
  expect(session.cookie).not.toBe('');
  expect(session.token).not.toBe('');
});

it('refuses a guarded route with no credentials', async () => {
  const response = await profile();

  expect(response.status).toBe(401);
});

it('refuses a guarded route with a bearer token that is not one', async () => {
  const response = await profile({ authorization: 'Bearer not-a-real-token' });

  expect(response.status).toBe(401);
});

it('refuses a guarded route with a forged session cookie', async () => {
  const response = await profile({
    cookie: 'better-auth.session_token=forged.signature',
  });

  expect(response.status).toBe(401);
});

it('admits the session cookie and names the caller', async () => {
  const response = await profile({ cookie: session.cookie });

  expect(response.status).toBe(200);
  const body = (await response.json()) as { email: string; sessionId: string };
  expect(body.email).toBe(CREDENTIALS.email);
  expect(body.sessionId).not.toBe('');
});

it('admits the bearer token as well as the cookie', async () => {
  const response = await profile({
    authorization: `Bearer ${session.token}`,
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as { email: string };
  expect(body.email).toBe(CREDENTIALS.email);
});

it('skips the guard entirely on a @Public() route', async () => {
  const response = await profile({}, '/anonymous');

  expect(response.status).toBe(200);
  // No session is looked up, so a caller is not established even with a cookie.
  expect(await response.json()).toEqual({ caller: null });
});

it('forbids @Roles("admin") for a signed-in user without the role', async () => {
  const response = await profile({ cookie: session.cookie }, '/audit');

  // Authenticated and refused: 403 rather than the 401 above.
  expect(response.status).toBe(403);
});

it('admits @Roles("admin") once the role is on the user', async () => {
  app
    .get(SyncDatabase<typeof schema>)
    .update(user)
    .set({ role: 'admin' })
    .where(eq(user.email, CREDENTIALS.email))
    .run();

  const response = await profile({ cookie: session.cookie }, '/audit');

  expect(response.status).toBe(200);
  const body = (await response.json()) as { caller: string };
  expect(body.caller).toBe(CREDENTIALS.email);
});

it('refuses a sign-in with the wrong password', async () => {
  const response = await authPost('sign-in/email', {
    email: CREDENTIALS.email,
    password: 'not the password',
  });

  expect(response.status).toBe(401);
});

it('refuses a sign-in for an address that never signed up', async () => {
  const response = await authPost('sign-in/email', {
    email: 'nobody@example.test',
    password: 'a long enough password',
  });

  expect(response.status).toBe(401);
});

it('refuses a sign-up under the minimum password length', async () => {
  const response = await authPost('sign-up/email', {
    email: 'short@example.test',
    password: 'short',
    name: 'Short',
  });

  expect(response.status).toBe(400);
});

it('refuses a second sign-up for the same address', async () => {
  const response = await authPost('sign-up/email', CREDENTIALS);

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
});

it('stops admitting the cookie after sign-out', async () => {
  const signOut = await authPost('sign-out', {}, { cookie: session.cookie });
  expect(signOut.status).toBe(200);

  const after = await profile({ cookie: session.cookie });
  expect(after.status).toBe(401);
});
