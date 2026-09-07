import { afterAll, beforeAll, expect, it } from 'bun:test';
import { PubSub, type HttpApp } from '@dunx/http';
import { connect } from './chat/ws-client.js';
import { Lobby } from './chat/lobby.service.js';
import { createApp } from './main.js';

/**
 * The websocket half, including the branches nothing reached.
 *
 * The tour opens a chat socket and asserts on the log line it produces. What no
 * test covered: the upgrade being **refused**, the telemetry gateway's text-frame
 * path, and whether a subscriber is dropped when its socket goes away without a
 * close frame. The load run opens and aborts thousands of sockets per run and
 * only ever checked the subscriber count at the end, so a leak smaller than the
 * run was invisible.
 */
let app: HttpApp;
let base = '';

beforeAll(async () => {
  app = await createApp();
  base = await app.listen(0);
});

afterAll(async () => {
  await app.shutdown();
});

const socketUrl = (path: string): string =>
  new URL(path, base).href.replace('http', 'ws');

/**
 * The subscriber count once every socket closed by an earlier test has gone.
 *
 * A close is a round trip, so reading the count straight after one races the
 * server's own cleanup: this suite read 2 as its baseline and asserted 3 while
 * the previous test's two sockets were still on their way out.
 */
const settledCount = async (): Promise<number> => {
  const pubsub = app.get(PubSub);
  let last = pubsub.subscriberCount(Lobby.TOPIC);
  for (let i = 0; i < 20; i += 1) {
    await Bun.sleep(50);
    const now = pubsub.subscriberCount(Lobby.TOPIC);
    if (now === last) return now;
    last = now;
  }
  return last;
};

it('refuses the upgrade when @OnUpgrade returns a Response', async () => {
  const opened = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(socketUrl('chat?as=banned'));
    const timer = setTimeout(() => resolve(false), 2000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      socket.close();
      resolve(true);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  expect(opened).toBe(false);
});

it('answers the refused upgrade with the status the handler chose', async () => {
  const response = await fetch(new URL('chat?as=banned', base), {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': btoa('0123456789abcdef'),
      'sec-websocket-version': '13',
    },
  });

  expect(response.status).toBe(403);
  expect(await response.text()).toBe('nope');
});

it('welcomes a socket the upgrade admitted', async () => {
  const client = await connect(base);

  expect(await client.next()).toBe('welcome');
  client.close();
});

it('broadcasts to every subscriber and answers the sender', async () => {
  const first = await connect(base);
  const second = await connect(base);
  expect(await first.next()).toBe('welcome');
  expect(await second.next()).toBe('welcome');

  first.send('say', 'hello lobby');

  // The broadcast reaches both, and the reply carries the delivery count.
  const delivered = [
    await first.next(),
    await first.next(),
    await second.next(),
  ];
  expect(delivered.some((frame) => frame.includes('hello lobby'))).toBe(true);
  expect(delivered.some((frame) => frame.includes('delivered'))).toBe(true);

  first.close();
  second.close();
});

it('drops the subscriber when a socket closes', async () => {
  const pubsub = app.get(PubSub);
  const before = await settledCount();

  const client = await connect(base);
  await client.next();
  expect(pubsub.subscriberCount(Lobby.TOPIC)).toBe(before + 1);

  client.close();
  // The close is a round trip, so the count settles a tick later.
  await Bun.sleep(150);
  expect(pubsub.subscriberCount(Lobby.TOPIC)).toBe(before);
});

it('drops the subscriber when a socket goes away with no close frame', async () => {
  const pubsub = app.get(PubSub);
  const before = await settledCount();

  const socket = new WebSocket(socketUrl('chat'));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    setTimeout(() => reject(new Error('the socket never opened')), 2000);
  });
  expect(pubsub.subscriberCount(Lobby.TOPIC)).toBe(before + 1);

  // No close handshake: the half a clean-close-only cleanup path would miss.
  socket.terminate();
  await Bun.sleep(250);
  expect(pubsub.subscriberCount(Lobby.TOPIC)).toBe(before);
});

it('summarises a binary frame on the telemetry gateway', async () => {
  const client = await connect(base, 'telemetry');

  client.sendRaw(new Uint8Array([1, 2, 3, 4]));
  const frame = await client.next();

  expect(frame).toContain('Blob(4)');
  expect(frame).toContain('[1, 2, 3, 4]');
  client.close();
});

it('refuses a text frame where the telemetry gateway wants binary', async () => {
  const client = await connect(base, 'telemetry');

  client.sendRaw('not binary');
  const frame = await client.next();

  expect(frame).toBe('expected a binary frame, got 10 chars of text');
  client.close();
});
