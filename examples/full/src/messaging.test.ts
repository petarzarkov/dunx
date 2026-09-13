import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { createApp } from './main.js';
import { runTour } from './tour/run-tour.js';
import type { Handled } from './messaging/orders.messages.js';

/**
 * **No second process to spawn.** `MessagingModule` sets `consume: true`, so
 * building the app is enough: the container opens one consumer per queue at
 * `onInit` and drains them at `onShutdown`.
 *
 * Every assertion is skipped when the broker is unreachable, because `bun run
 * test` has to pass on a machine with nothing running - the same contract the
 * queue and cache routes keep.
 */
let app: HttpApp;
let base: string;
let brokerUp = false;

const api = (path: string): URL => new URL(`api/${path}`, base);

interface Placed {
  readonly id: string;
  readonly exchange: string;
  readonly routingKey: string;
}

interface Inbox {
  readonly connected: boolean;
  readonly handled: readonly Handled[];
}

const place = async (
  id: string,
  shipped = false,
): Promise<{ status: number; body: Placed }> => {
  const response = await fetch(api('messaging/orders'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, total: 12, shipped }),
  });
  return { status: response.status, body: (await response.json()) as Placed };
};

const inbox = async (): Promise<Inbox> =>
  (await (await fetch(api('messaging/orders'))).json()) as Inbox;

/**
 * Polls rather than sleeping a fixed span: a delivery is milliseconds away on a
 * reachable broker and never arrives on an absent one.
 *
 * These assertions read what **this** container consumed, which holds because it
 * is the only app running while this file does. A second copy of the app sharing
 * the broker would have the deliveries round-robined between them, which is what
 * `@AmqpHandler`'s one-queue-one-handler rule is about.
 *
 * 10 s rather than 5: a GitHub runner is 2 to 3 times slower than a laptop and
 * this file runs beside the rest of the suite. A real failure still fails.
 */
const settle = async (id: string, count: number): Promise<Inbox> => {
  const deadline = Date.now() + 10_000;
  let seen = await inbox();
  while (
    Date.now() < deadline &&
    seen.handled.filter((entry) => entry.id === id).length < count
  ) {
    await Bun.sleep(50);
    seen = await inbox();
  }
  return seen;
};

beforeAll(async () => {
  app = await createApp();
  base = await app.listen(0);

  // One publish decides it: with no broker the route answers 503 rather than
  // hanging, because publisher confirms are on.
  brokerUp = (await place('probe')).status === 201;
});

/**
 * Past bun's 5 s default, because the teardown this file reaches with nothing
 * running is the slow one: each consumer drain waits `drainTimeoutMs`, the
 * connection close waits its own bound, and the queue and cache are shutting down
 * against a Redis that is not answering either. All of that is bounded, and the
 * sum is simply more than 5 s.
 */
afterAll(async () => {
  await app.shutdown();
}, 30_000);

it('routes one publish to the queue its key binds', async () => {
  if (!brokerUp) return;
  const id = `only-placed-${Bun.randomUUIDv7().slice(0, 8)}`;
  const { status, body } = await place(id);

  expect(status).toBe(201);
  expect(body.routingKey).toBe('order.placed');

  const seen = await settle(id, 1);
  const mine = seen.handled.filter((entry) => entry.id === id);
  expect(mine.map((entry) => entry.queue)).toEqual(['dunx-full.orders.placed']);
});

it('binds a second queue to the same exchange', async () => {
  if (!brokerUp) return;
  const id = `shipped-${Bun.randomUUIDv7().slice(0, 8)}`;
  await place(id, true);

  const seen = await settle(id, 1);
  expect(seen.connected).toBe(true);
  expect(
    seen.handled.filter((entry) => entry.id === id).map((e) => e.queue),
  ).toEqual(['dunx-full.orders.shipped']);
});

/**
 * The reason `AmqpPublisher.publish` exists rather than `publisher().send()`. The
 * handler runs in the trace the publishing request was in, so a flow that crossed
 * the broker joins in one log query.
 */
it('continues the publisher trace in the handler', async () => {
  if (!brokerUp) return;
  const id = `traced-${Bun.randomUUIDv7().slice(0, 8)}`;
  const traceId = `${'f'.repeat(31)}1`;

  await fetch(api('messaging/orders'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      traceparent: `00-${traceId}-${'a'.repeat(16)}-01`,
    },
    body: JSON.stringify({ id, total: 1, shipped: false }),
  });

  const seen = await settle(id, 1);
  expect(seen.handled.find((entry) => entry.id === id)?.traceId).toBe(traceId);
});

/**
 * `requeue: true` on the placed queue would redeliver a body that can never parse
 * forever, so a malformed one is dropped rather than thrown.
 */
it('drops a delivery that is not an order', async () => {
  if (!brokerUp) return;
  const before = (await inbox()).handled.length;

  const response = await fetch(api('messaging/raw'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonsense: true }),
  });
  expect(response.status).toBe(201);

  await Bun.sleep(1_000);
  expect((await inbox()).handled).toHaveLength(before);
});

it('answers 503 with no broker rather than hanging', async () => {
  if (brokerUp) return;
  const { status } = await place('degraded');
  expect(status).toBe(503);
  expect((await inbox()).connected).toBe(false);
});

/**
 * The landing page is where a visitor reaches these routes, and it is the half a
 * rename can miss: `landing.js` holds the paths as strings, so nothing else fails
 * when one moves. Asserted against the OpenAPI document rather than a literal, so
 * the page and the controller cannot drift apart quietly.
 *
 * No broker needed - this is the wiring, not the delivery.
 */
it('wires the landing page panel to the routes that exist', async () => {
  const page = await (await fetch(new URL('/', base))).text();
  expect(page).toContain('<h2>Message broker</h2>');
  for (const id of ['mq-place', 'mq-ship', 'mq-bad', 'mq-out']) {
    expect(page).toContain(`id="${id}"`);
  }

  const byName = (left: string, right: string): number =>
    left.localeCompare(right);

  const script = await (await fetch(new URL('/landing.js', base))).text();
  const used = [
    ...new Set(
      [...script.matchAll(/'(\/api\/messaging\/[^']*)'/g)].flatMap(
        (match) => match[1] ?? [],
      ),
    ),
  ].sort(byName);

  const document = (await (await fetch(api('openapi.json'))).json()) as {
    paths: Record<string, unknown>;
  };
  const mounted = Object.keys(document.paths)
    .filter((path) => path.startsWith('/api/messaging/'))
    .sort(byName);

  expect(used).toEqual(mounted);
});

/**
 * Here rather than beside the other tour assertions because `tour.test.ts` is at
 * the 800-line cap, and this one spawns a tour of its own rather than reading the
 * shared run.
 *
 * Both variables, because `defaultAmqpUrl` falls back to `$AMQP_URL`: setting one
 * would leave the other pointing at a reachable broker.
 */
it('tours and exits 0 with no broker at all', async () => {
  const unreachable = 'amqp://127.0.0.1:1';
  const run = await runTour({
    RABBITMQ_URL: unreachable,
    AMQP_URL: unreachable,
  });

  expect(run.code).toBe(0);
  expect(run.text).toContain('skipping the message broker section');
}, 30_000);
