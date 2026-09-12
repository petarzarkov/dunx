import { afterAll, beforeAll, expect, it } from 'bun:test';
import { EventBus, EventBusModule, EventRegistry } from '@dunx/core';
import { createTestServer, testClient, type TestServer } from '@dunx/testing';
import { Audit } from './events/audit.service.js';
import { EventsModule } from './events/events.module.js';
import { Notifications, REVIEW_LIMIT } from './events/notifications.service.js';
import { OrderPlaced } from './events/orders.events.js';
import { Startup } from './events/startup.service.js';

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
  // EventsModule first, so its providers are built before EventRegistry is.
  server = await createTestServer({
    modules: [EventsModule, EventBusModule],
  });
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
    'Notifications.ready',
    'Notifications.countSettled',
    'Notifications.logFirstSettlement',
  ]);
});

it('delivers an event emitted from an onInit that ran first', async () => {
  // Startup emits AppReady from its own onInit, and EventBusModule is imported
  // after the module it lives in. Wiring happens in onBeforeInit, so it lands.
  expect(server.app.get(Startup).reached).toBe(1);
  expect(server.app.get(Notifications).readyCount).toBe(1);
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
  const flagged = () =>
    registry
      .subscribersOf(OrderPlaced)
      .find((entry) => entry.subscriber === 'Notifications.flagForReview');

  // Its own orders and its own baseline, so the file can run one test alone.
  const handledBefore = flagged()?.handled ?? 0;
  const failedBefore = flagged()?.failed ?? 0;
  await place(12);
  await place(REVIEW_LIMIT + 1);

  expect(flagged()?.handled).toBe(handledBefore + 1);
  expect(flagged()?.failed).toBe(failedBefore + 1);
  expect(String(flagged()?.lastError)).toContain('review limit');
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
