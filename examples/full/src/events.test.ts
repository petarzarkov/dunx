import { afterAll, beforeAll, expect, it } from 'bun:test';
import { EventBus, EventRegistry } from '@dunx/core';
import { createTestServer, testClient, type TestServer } from '@dunx/testing';
import { Audit } from './events/audit.service.js';
import { EventsModule } from './events/events.module.js';
import { Notifications, REVIEW_LIMIT } from './events/notifications.service.js';
import { OrderPlaced } from './events/orders.events.js';

/**
 * The EventBus routes, on their own server so `service.test.ts` stays under the
 * 800-line cap.
 */
let server: TestServer;
let client: ReturnType<typeof testClient>;

interface Dispatched {
  event: string;
  handled: number;
  failures: { subscriber: string; error: string }[];
}

const place = async (total: number): Promise<Dispatched> =>
  (
    await client.json<Dispatched>('events/orders', {
      method: 'POST',
      json: { total },
    })
  ).body;

beforeAll(async () => {
  server = await createTestServer({ modules: [EventsModule] });
  client = testClient(server.url);
});

afterAll(async () => {
  await server.close();
});

it('subscribes every @OnEvent method in the graph at boot', async () => {
  const { body: listed } = await client.json<
    { event: string; subscriber: string }[]
  >('events/subscriptions');

  expect(listed.map((entry) => entry.subscriber)).toEqual([
    'Audit.record',
    'Notifications.notify',
    'Notifications.flagForReview',
    'Notifications.countSettled',
    'Notifications.logFirstSettlement',
  ]);
});

it('finishes every subscriber before emit resolves', async () => {
  const before = server.app.get(Audit).rows.length;
  const dispatch = await place(12);

  expect(dispatch.event).toBe('OrderPlaced');
  expect(dispatch.handled).toBe(3);
  expect(dispatch.failures).toEqual([]);

  // The async handler's row and the sync handler's waitUntil work are both done
  // by the time the route returned, with nothing in the route awaiting them.
  const { body: rows } =
    await client.json<{ id: string; total: number }[]>('events/audit');
  expect(rows).toHaveLength(before + 1);
  expect(rows.at(-1)?.total).toBe(12);
  expect(server.app.get(Notifications).sent).toContain(String(rows.at(-1)?.id));
});

it('carries a throwing subscriber without failing the others', async () => {
  const dispatch = await place(REVIEW_LIMIT + 1);

  expect(dispatch.failures).toHaveLength(1);
  expect(dispatch.failures[0]?.subscriber).toBe('Notifications.flagForReview');
  expect(dispatch.failures[0]?.error).toContain('review limit');
  // The two registered around it still ran.
  expect(dispatch.handled).toBe(2);
});

it('counts deliveries on the subscription EventRegistry listed', async () => {
  const registry = server.app.get(EventRegistry);
  const [flagged] = registry
    .subscribersOf(OrderPlaced)
    .filter((entry) => entry.subscriber === 'Notifications.flagForReview');

  expect(flagged?.failed).toBe(1);
  expect(flagged?.handled).toBeGreaterThan(0);
  expect(String(flagged?.lastError)).toContain('review limit');
});

it('takes an imperative subscription and drops it on unsubscribe', async () => {
  const seen: string[] = [];
  const subscription = server.app
    .get(EventBus)
    .on(OrderPlaced, (event) => seen.push(event.id), { as: 'suite' });

  await place(1);
  subscription.unsubscribe();
  await place(1);

  expect(seen).toHaveLength(1);
  expect(subscription.active).toBe(false);
});
