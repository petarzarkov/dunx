import { describe, expect, it } from 'bun:test';
import { PubSub } from './pubsub.js';
import { RedisRelay } from './redis-relay.js';
import {
  open,
  released,
  stop,
  TOPIC,
  twoNodes,
  until,
  AppModule,
  socketFor,
  opened,
} from './relay.fixture.js';
import { HttpFactory } from '../server/factory.js';

/**
 * `RedisRelay` against a broker that is not there, and against a real one when
 * `redis://localhost:6379` answers. Both halves turn on one hazard: a client that
 * could not connect, or that entered subscriber mode, keeps the event loop alive
 * past `close()`, and only a subprocess's exit code can see that.
 */

const RELAY_URL = 'redis://localhost:6379';

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
        './redis-relay.ts',
        'RedisRelay',
        "const relay = new RedisRelay({ url: 'redis://127.0.0.1:1', connectionTimeout: 500 });\n" +
          "try { await relay.subscribe('ch', () => {}); } catch (error) { void error; }\n",
      ),
    ).toBe(0);
  });
});

describe.skipIf(!HAS_REDIS)('two nodes over real Redis', () => {
  it('leaves subscriber mode on close, so the process exits', async () => {
    // The other half of the same hazard: a client that *did* enter subscriber mode
    // also holds the loop open after `close()`, which is why `close()`
    // unsubscribes first. Without that this times out too.
    expect(
      await released(
        './redis-relay.ts',
        'RedisRelay',
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
      const socket = socketFor(urlB);
      socket.binaryType = 'arraybuffer';
      const received: number[][] = [];
      socket.addEventListener('message', (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          received.push([...new Uint8Array(event.data)]);
        }
      });
      await opened(socket);

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
