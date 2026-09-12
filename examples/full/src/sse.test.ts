import { afterAll, beforeAll, expect, it } from 'bun:test';
import { createTestServer, type TestServer } from '@dunx/testing';
import { configModule } from './config.js';
import { NotificationFeed } from './sse/notification.feed.js';
import { EventsModule } from './sse/sse.module.js';

/**
 * The event-stream routes over a real server. The tour narrates the same routes
 * through `HttpService.streamSse`, which yields `data:` payloads and hides the
 * framing; this is where the bytes on the wire are asserted.
 */
let server: TestServer;

/** The comment every stream opens with, so Bun flushes the headers. */
const OPEN = ':\n\n';

beforeAll(async () => {
  server = await createTestServer({
    modules: [configModule(), EventsModule],
  });
});

afterAll(async () => {
  await server.close();
});

it('answers text/event-stream and frames every field', async () => {
  const response = await server.request('/events/ticks?count=2');

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(await response.text()).toBe(
    `${OPEN}event: tick\nid: 1\ndata: {"tick":1}\n\n` +
      'event: tick\nid: 2\ndata: {"tick":2}\n\n',
  );
});

it('validates the query schema of an @Sse route like any other', async () => {
  const response = await server.request('/events/ticks?count=nope');
  expect(response.status).toBe(400);
});

it('resumes from Last-Event-ID', async () => {
  const response = await server.request('/events/ticks?count=1', {
    headers: { 'last-event-id': '9' },
  });
  expect(await response.text()).toBe(
    `${OPEN}event: tick\nid: 10\ndata: {"tick":10}\n\n`,
  );
});

it('pushes into a held stream and forgets a client that left', async () => {
  const feed = server.app.get(NotificationFeed);
  const client = new AbortController();
  const response = await fetch(new URL('/events/notifications', server.url), {
    signal: client.signal,
  });
  expect(feed.subscribers).toBe(1);

  feed.publish('deploy finished');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let read = '';
  while (!read.includes('event: notice')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    read += decoder.decode(chunk.value, { stream: true });
  }
  expect(read).toContain('data: {"message":"deploy finished"}');

  client.abort();
  await Bun.sleep(20);
  // The stream closed itself, which is also what cleared its heartbeat timer.
  expect(feed.subscribers).toBe(0);
});
