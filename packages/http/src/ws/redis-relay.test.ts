import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { HttpFactory, type HttpApp } from '../server/factory.js';
import { Gateway, OnOpen } from './decorators.js';
import { PubSub } from './pubsub.js';
import { RedisRelay } from './redis-relay.js';
import type { PubSubRelay } from './relay.js';
import type { Socket } from './socket.js';

/**
 * `RedisRelay` against a broker that is not there, and against a real one when
 * `redis://localhost:6379` answers. Both halves turn on one hazard: a client that
 * could not connect, or that entered subscriber mode, keeps the event loop alive
 * past `close()`, and only a subprocess's exit code can see that.
 */

const TOPIC = 'lobby';
const RELAY_URL = 'redis://localhost:6379';

@Gateway('/live')
class LiveGateway {
  @OnOpen()
  opened(socket: Socket): void {
    socket.subscribe(TOPIC);
    socket.send('ready');
  }
}

@Module({ providers: [LiveGateway] })
class AppModule {}

/** A client that keeps every frame, so a *second* delivery is visible. */
interface Client {
  readonly frames: string[];
  close(): void;
}

const open = async (base: string): Promise<Client> => {
  const socket = new WebSocket(
    new URL('/live', base).href.replace(/^http/, 'ws'),
  );
  const frames: string[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    frames.push(String(event.data));
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the socket never opened')),
      2000,
    );
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  // 'ready' is sent from @OnOpen and would otherwise be counted as a delivery.
  await until(() => frames.length === 1);
  frames.length = 0;
  return { frames, close: () => socket.close() };
};

const until = async (done: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await Bun.sleep(5);
  }
};

const twoNodes = async (
  relayA: PubSubRelay,
  relayB: PubSubRelay,
  channel: string,
): Promise<{ apps: HttpApp[]; urls: string[] }> => {
  const apps: HttpApp[] = [];
  const urls: string[] = [];
  for (const relay of [relayA, relayB]) {
    const app = await HttpFactory.create(AppModule, {
      requestLogging: false,
      relay,
      relayChannel: channel,
    });
    urls.push(await app.listen(0));
    apps.push(app);
  }
  return { apps, urls };
};

const stop = async (apps: readonly HttpApp[]): Promise<void> => {
  for (const app of apps) await app.shutdown();
};

const redisReachable = async (): Promise<boolean> => {
  const client = new Bun.RedisClient(RELAY_URL, { maxRetries: 0 });
  try {
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
};

const HAS_REDIS = await redisReachable();

describe('RedisRelay when Redis is not there', () => {
  it('rejects a URL Bun would have accepted and failed on later', () => {
    expect(() => new RedisRelay({ url: 'not-a-url' })).toThrow(
      /not a valid URL/,
    );
    expect(() => new RedisRelay({ url: 'http://localhost:6379' })).toThrow(
      /Unsupported protocol/,
    );
  });

  it('redacts the password it was given', () => {
    expect(
      new RedisRelay({ url: 'redis://user:hunter2@localhost:6379' }).url,
    ).not.toContain('hunter2');
  });

  it('still boots, still fans out locally, and reports the failure once', async () => {
    const failures: string[] = [];
    // Nothing listens on port 1. maxRetries defaults to 0, which is also what
    // stops a retry timer from outliving the test run.
    const relay = new RedisRelay({ url: 'redis://127.0.0.1:1' });
    const app = await HttpFactory.create(AppModule, { requestLogging: false });
    const url = await app.listen(0);

    try {
      const pubsub = app.get(PubSub);
      await pubsub.relayThrough(relay, {
        channel: 'test',
        onError: (_error, phase) => failures.push(phase),
      });
      expect(failures).toEqual(['subscribe']);

      const client = await open(url);
      pubsub.publishEvent(TOPIC, 'said', 'local anyway');
      await until(() => client.frames.length === 1);
      await Bun.sleep(100);
      expect(client.frames).toHaveLength(1);
      // Still one entry: a broker that is down must not log once per publish.
      expect(failures).toEqual(['subscribe']);
      client.close();
    } finally {
      await app.shutdown();
    }
  });

  it('releases the connection it could not open, so the process exits', async () => {
    // `bun test` exits the runner itself, so a held-open event loop is invisible
    // here and needs a subprocess. Measured on Bun 1.3.14: a `subscribe()` that
    // cannot reach the server keeps the loop alive past `close()` even with
    // `maxRetries: 0`, so `RedisRelay` connects first. Without that this times out.
    expect(
      await released(
        "const relay = new RedisRelay({ url: 'redis://127.0.0.1:1', connectionTimeout: 500 });\n" +
          "try { await relay.subscribe('ch', () => {}); } catch (error) { void error; }\n",
      ),
    ).toBe(0);
  });
});

/**
 * Runs `body` against a real `RedisRelay` in a subprocess, calls `close()`, and
 * answers the exit code - `0` only if nothing kept the event loop alive.
 */
const released = async (body: string): Promise<number> => {
  const module = new URL('./redis-relay.ts', import.meta.url).pathname;
  const proc = Bun.spawn(
    [
      'bun',
      '-e',
      `const { RedisRelay } = await import(${JSON.stringify(module)});\n` +
        `${body}await relay.close();\nconsole.log('released');\n`,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  const timer = setTimeout(() => proc.kill(), 8000);
  const code = await proc.exited;
  clearTimeout(timer);
  return code;
};

describe.skipIf(!HAS_REDIS)('two nodes over real Redis', () => {
  it('leaves subscriber mode on close, so the process exits', async () => {
    // The other half of the same hazard: a client that *did* enter subscriber mode
    // also holds the loop open after `close()`, which is why `close()`
    // unsubscribes first. Without that this times out too.
    expect(
      await released(
        `const relay = new RedisRelay({ url: ${JSON.stringify(RELAY_URL)} });\n` +
          `await relay.subscribe('dunx:test:exit', () => {});\n`,
      ),
    ).toBe(0);
  });

  it('delivers a publish exactly once per subscriber across both nodes', async () => {
    // A channel per run, so a leftover subscriber or a concurrent run cannot
    // deliver into this test.
    const channel = `dunx:test:${Bun.randomUUIDv7()}`;
    const { apps, urls } = await twoNodes(
      new RedisRelay({ url: RELAY_URL }),
      new RedisRelay({ url: RELAY_URL }),
      channel,
    );
    const [first, second] = apps;
    const [urlA, urlB] = urls;
    if (!first || !second || !urlA || !urlB)
      throw new Error('two nodes expected');

    try {
      const [ada, grace] = await Promise.all([open(urlA), open(urlB)]);
      if (!ada || !grace) throw new Error('clients expected');

      first.get(PubSub).publishEvent(TOPIC, 'said', 'over redis');
      const expected = JSON.stringify({ event: 'said', data: 'over redis' });

      await until(() => grace.frames.length > 0);
      await Bun.sleep(250);
      expect(ada.frames).toEqual([expected]);
      expect(grace.frames).toEqual([expected]);

      // And the other direction, on the same channel.
      ada.frames.length = 0;
      grace.frames.length = 0;
      second.get(PubSub).publishEvent(TOPIC, 'said', 'and back');
      const back = JSON.stringify({ event: 'said', data: 'and back' });
      await until(() => ada.frames.length > 0);
      await Bun.sleep(250);
      expect(ada.frames).toEqual([back]);
      expect(grace.frames).toEqual([back]);

      ada.close();
      grace.close();
    } finally {
      await stop(apps);
    }
  });

  it('relays a binary frame', async () => {
    const channel = `dunx:test:${Bun.randomUUIDv7()}`;
    const { apps, urls } = await twoNodes(
      new RedisRelay({ url: RELAY_URL }),
      new RedisRelay({ url: RELAY_URL }),
      channel,
    );
    const [first] = apps;
    const [, urlB] = urls;
    if (!first || !urlB) throw new Error('two nodes expected');

    try {
      const socket = new WebSocket(
        new URL('/live', urlB).href.replace(/^http/, 'ws'),
      );
      socket.binaryType = 'arraybuffer';
      const received: number[][] = [];
      socket.addEventListener('message', (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          received.push([...new Uint8Array(event.data)]);
        }
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('never opened')), 2000);
        socket.addEventListener(
          'open',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

      first.get(PubSub).publish(TOPIC, new Uint8Array([1, 2, 3, 250]));
      await until(() => received.length > 0);
      await Bun.sleep(150);
      expect(received).toEqual([[1, 2, 3, 250]]);
      socket.close();
    } finally {
      await stop(apps);
    }
  });
});
