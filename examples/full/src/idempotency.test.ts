import { afterAll, beforeAll, expect, it } from 'bun:test';
import { EventBusModule } from '@dunx/core';
import { IDEMPOTENT_REPLAYED_HEADER } from '@dunx/http';
import { createTestServer, type TestServer } from '@dunx/testing';
import { configModule } from './config.js';
import { Audit } from './events/audit.service.js';
import { EventsModule } from './events/events.module.js';
import { IdempotencyKeysModule } from './idempotency/idempotency.module.js';

/**
 * `POST /events/orders` with an `Idempotency-Key`, against the store the module
 * picks at boot: Redis when the cache answers, which it does in CI. The keys are
 * random, so two runs against one Redis never meet.
 */
let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({
    modules: [
      configModule(),
      EventsModule,
      EventBusModule,
      IdempotencyKeysModule,
    ],
  });
});

afterAll(async () => {
  await server.app.shutdown();
});

const placed = (): number => server.app.get(Audit).rows.length;

const place = (total: number, key?: string) =>
  server.request('events/orders', {
    method: 'POST',
    headers: key === undefined ? {} : { 'idempotency-key': key },
    json: { total },
  });

it('places the order once however often the request is retried', async () => {
  const key = crypto.randomUUID();
  const before = placed();

  const first = await place(10, key);
  expect(first.status).toBe(201);
  const answer = await first.json();

  const retry = await place(10, key);
  expect(retry.status).toBe(201);
  expect(retry.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
  expect(await retry.json()).toEqual(answer);
  expect(placed()).toBe(before + 1);
});

it('refuses the same key for a different order with 422', async () => {
  const key = crypto.randomUUID();
  await place(10, key);
  expect((await place(11, key)).status).toBe(422);
});

it('places an order without a key exactly as before', async () => {
  const before = placed();
  expect((await place(1)).status).toBe(201);
  expect((await place(1)).status).toBe(201);
  expect(placed()).toBe(before + 2);
});
