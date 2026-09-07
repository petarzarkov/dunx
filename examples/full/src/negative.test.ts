import { afterAll, beforeAll, expect, it } from 'bun:test';
import { RequestMetrics, type HttpApp } from '@dunx/http';
import { testClient, type JsonInit, type TestClient } from '@dunx/testing';
import { createApp } from './main.js';

/**
 * The refusals: what every route answers when the request is wrong.
 *
 * `service.test.ts` covers the happy path and four failures alongside it. This
 * file is the other side, and it exists because the load run enumerated statuses
 * that no test asserted: 22 routes declare zod schemas and three of them had a
 * 400 test, five handlers `throw` a 404 and one of those was covered.
 */
let app: HttpApp;
let client: TestClient;

const json = <T>(path: string, init?: JsonInit) =>
  client.json<T>(`api/${path}`, init);

const send = (
  method: string,
  body: unknown,
  headers?: Record<string, string>,
): JsonInit => ({
  method,
  json: body,
  ...(headers === undefined ? {} : { headers }),
});

/** The shape `HttpError` serialises to, which every refusal below shares. */
interface ErrorBody {
  error: string;
  status: number;
}

beforeAll(async () => {
  app = await createApp();
  client = testClient(await app.listen(0));
});

afterAll(async () => {
  await app.shutdown();
});

it('rejects a query parameter over its maximum', async () => {
  const { status, body } = await json<ErrorBody>('users?limit=999');

  expect(status).toBe(400);
  expect(body.status).toBe(400);
  // The message names the parameter, which is the whole point of validating at
  // the edge rather than in the handler.
  expect(JSON.stringify(body)).toContain('limit');
});

it('rejects a query parameter that will not coerce', async () => {
  const { status } = await json<ErrorBody>('users?limit=not-a-number');

  expect(status).toBe(400);
});

it('rejects a path parameter under its minimum', async () => {
  const { status } = await json<ErrorBody>('users/0');

  expect(status).toBe(400);
});

it('rejects a path parameter that is not a number', async () => {
  const { status } = await json<ErrorBody>('users/abc');

  expect(status).toBe(400);
});

it('answers 404 for a user id that does not exist', async () => {
  const { status, body } = await json<ErrorBody>('users/999999');

  expect(status).toBe(404);
  expect(body.status).toBe(404);
});

it('rejects a body field of the wrong type', async () => {
  const { status } = await json<ErrorBody>('notes', send('POST', { text: 42 }));

  expect(status).toBe(400);
});

it('rejects a body with the field missing', async () => {
  const { status } = await json<ErrorBody>('notes', send('POST', {}));

  expect(status).toBe(400);
});

it('rejects a body that is not JSON at all', async () => {
  const response = await client.request('api/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"text": ',
  });

  // A parse failure is the caller's fault, so it must not surface as a 500.
  expect(response.status).toBe(400);
});

it('parses a JSON body sent with no content-type', async () => {
  const response = await client.request('api/notes', {
    method: 'POST',
    body: JSON.stringify({ text: 'no content type' }),
  });

  // Lenient on purpose, and asserted so it stays a decision: the body is read
  // and validated on its own merits rather than on the header a client set.
  expect(response.status).toBe(201);
});

it('rejects an image width over the ceiling', async () => {
  const { status } = await json<ErrorBody>('images/render?width=9999');

  expect(status).toBe(400);
});

it('rejects an image format outside the enum', async () => {
  const { status } = await json<ErrorBody>('images/render?format=bogus');

  expect(status).toBe(400);
});

it('describes an inline image, and rejects one that is not base64', async () => {
  const rendered = await client.request('api/images/render?width=8&format=png');
  const bytes = await rendered.bytes();
  const base64 = Buffer.from(bytes).toString('base64');

  const ok = await json<{ width: number; format: string }>(
    'images/describe',
    send('POST', { base64 }),
  );
  // POST answers 201 unless a route says otherwise, `describe` does not.
  expect(ok.status).toBe(201);
  expect(ok.body.width).toBe(8);

  const bad = await json<ErrorBody>(
    'images/describe',
    send('POST', { base64: '' }),
  );
  expect(bad.status).toBe(400);
});

it('rejects a cache ttl over its maximum', async () => {
  const { status } = await json<ErrorBody>(
    'cache/ttl-too-long',
    send('PUT', { data: { a: 1 }, ttl: 99999 }),
  );

  expect(status).toBe(400);
});

it('rejects a cache payload that is not an object', async () => {
  const { status } = await json<ErrorBody>(
    'cache/wrong-shape',
    send('PUT', { data: 'not an object' }),
  );

  expect(status).toBe(400);
});

it('rejects an empty storage key', async () => {
  const { status } = await json<ErrorBody>('files/object?key=');

  expect(status).toBe(400);
});

it('rejects a storage key over its length limit', async () => {
  const { status } = await json<ErrorBody>(
    `files/object?key=${'k'.repeat(201)}`,
  );

  expect(status).toBe(400);
});

it('refuses to walk out of the storage root', async () => {
  const { status } = await json<ErrorBody>(
    `files/object?key=${encodeURIComponent('../../etc/passwd')}`,
  );

  // `Storage` raises `PathTraversalError`, which the controller maps rather than
  // letting it become a 500.
  expect(status).toBe(400);
});

it('answers 404 for a storage key that was never written', async () => {
  const { status } = await json<ErrorBody>(
    'files/object?key=never-written.txt',
  );

  expect(status).toBe(404);
});

it('rejects a file body over the size cap', async () => {
  const { status } = await json<ErrorBody>(
    'files/object?key=too-big.txt',
    send('PUT', { content: 'x'.repeat(64 * 1024 + 1) }),
  );

  expect(status).toBe(400);
});

it('writes, reads and deletes one object', async () => {
  const key = 'negative/roundtrip.txt';
  const q = `key=${encodeURIComponent(key)}`;

  const written = await json<{ key: string; bytes: number }>(
    `files/object?${q}`,
    send('PUT', { content: 'hello' }),
  );
  expect(written.status).toBe(200);
  expect(written.body.bytes).toBe(5);

  const read = await client.request(`api/files/object?${q}`);
  expect(read.status).toBe(200);
  expect(await read.text()).toContain('hello');

  const removed = await json<{ deleted: boolean }>(`files/object?${q}`, {
    method: 'DELETE',
  });
  expect(removed.status).toBe(200);
  expect(removed.body.deleted).toBe(true);

  const gone = await json<ErrorBody>(`files/object?${q}`);
  expect(gone.status).toBe(404);
});

it('reads and deletes one ledger entry, then answers 404 for both', async () => {
  const created = await json<{ id: number; memo: string }>(
    'ledger',
    send('POST', { memo: 'negative-test', amount: 7 }),
  );
  expect(created.status).toBe(201);
  const { id } = created.body;

  const read = await json<{ id: number; amount: number }>(`ledger/${id}`);
  expect(read.status).toBe(200);
  expect(read.body.amount).toBe(7);

  const removed = await json<{ deleted: boolean }>(`ledger/${id}`, {
    method: 'DELETE',
  });
  expect(removed.status).toBe(200);
  expect(removed.body.deleted).toBe(true);

  expect((await json<ErrorBody>(`ledger/${id}`)).status).toBe(404);
  expect(
    (await json<ErrorBody>(`ledger/${id}`, { method: 'DELETE' })).status,
  ).toBe(404);
});

it('rejects a ledger entry with no memo', async () => {
  const { status } = await json<ErrorBody>(
    'ledger',
    send('POST', { memo: '', amount: 1 }),
  );

  expect(status).toBe(400);
});

it('rejects a ledger amount that is not an integer', async () => {
  const { status } = await json<ErrorBody>(
    'ledger',
    send('POST', { memo: 'fractional', amount: 1.5 }),
  );

  expect(status).toBe(400);
});

it('rejects a transfer of a negative amount', async () => {
  const { status } = await json<ErrorBody>(
    'ledger/transfer',
    send('POST', { from: 'a', to: 'b', amount: -5 }),
  );

  expect(status).toBe(400);
});

it('answers 404 for a cache key that is not there', async () => {
  const { status } = await json<ErrorBody>('cache/definitely-not-stored');

  // 503 when no broker is up, which is the route degrading rather than failing.
  expect([404, 503]).toContain(status);
});

it('rejects a report with an empty title, once past the guards', async () => {
  const { status } = await json<ErrorBody>(
    'reports',
    send('POST', { title: '' }, { authorization: 'Bearer admin' }),
  );

  expect(status).toBe(400);
});

it('challenges before it validates', async () => {
  // Same invalid body, no credentials. The guard runs first, so this is a 401
  // rather than the 400 above: middleware order is observable here.
  const { status } = await json<ErrorBody>(
    'reports',
    send('POST', { title: '' }),
  );

  expect(status).toBe(401);
});

it('forbids a valid body from the wrong role', async () => {
  const { status } = await json<ErrorBody>(
    'reports',
    send(
      'POST',
      { title: 'from a viewer' },
      { authorization: 'Bearer viewer' },
    ),
  );

  expect(status).toBe(403);
});

it('forbids a rename from a role that is not the editor', async () => {
  const { status } = await json<ErrorBody>(
    'reports/1',
    send('PATCH', { title: 'renamed' }, { authorization: 'Bearer admin' }),
  );

  // `@Roles('editor')` at the method wins over `@Roles('admin')` at the class.
  expect(status).toBe(403);
});

it('answers 404 for an unmatched path under the prefix', async () => {
  const { status, body } = await json<ErrorBody>('nothing-here');

  expect(status).toBe(404);
  expect(body.error).toBe('NOT_FOUND');
});

it('answers 404 for a verb the route does not declare', async () => {
  const { status } = await json<ErrorBody>('notes', { method: 'DELETE' });

  expect(status).toBe(404);
});

it('answers 404 outside the global prefix', async () => {
  const response = await client.request('users');

  expect(response.status).toBe(404);
});

it('never counts the health probes against the rate limit', async () => {
  const live = await client.request('api/health/live');
  const ready = await client.request('api/health/ready');

  // The load run that found `/health/live` answering 429 behind a global
  // `ThrottleGuard` is why this is asserted rather than assumed. It raises the
  // budget so the app rather than the limiter is what it measures, which means
  // the run can no longer reach the limit on a probe: the exemption is visible
  // here instead, as the absence of the headers a counted route carries.
  expect(live.headers.get('ratelimit-limit')).toBeNull();
  expect(ready.headers.get('ratelimit-limit')).toBeNull();

  const counted = await client.request('api/notes');
  expect(counted.headers.get('ratelimit-limit')).not.toBeNull();
});

it('releases a request whose client went away mid-flight', async () => {
  const metrics = app.get(RequestMetrics);
  const settled = metrics.snapshot().inFlight;

  // `/upstream/slow` sleeps 300ms and is @SkipThrottle, so 25 of them are all
  // parked in the handler when the aborts land.
  const aborted = Array.from({ length: 25 }, async () => {
    const controller = new AbortController();
    const call = fetch(new URL('api/upstream/slow', client.url), {
      signal: controller.signal,
    }).catch(() => 'aborted');
    await Bun.sleep(20);
    controller.abort();
    return call;
  });
  await Promise.all(aborted);
  await Bun.sleep(600);

  // A client that hangs up is not an error the server has to answer for, but a
  // request it never lets go of is a leak that only shows under load.
  expect(metrics.snapshot().inFlight).toBe(settled);
  expect((await json<{ ok: true }>('reports/health')).status).toBe(200);
});
