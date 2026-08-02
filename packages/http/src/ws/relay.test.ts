import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { HttpFactory, type HttpApp } from '../server/factory.js';
import { Gateway, OnOpen } from './decorators.js';
import { PubSub } from './pubsub.js';
import { RedisRelay } from './redis-relay.js';
import { decodeRelay, encodeRelay, type PubSubRelay } from './relay.js';
import type { Socket } from './socket.js';

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

/**
 * An in-memory stand-in for Redis with the behaviour that matters: a publish is
 * delivered to *every* subscriber on the channel, the publisher included. That
 * echo is what would double-deliver without an origin check.
 */
class Bus {
  readonly published: string[] = [];
  readonly #listeners = new Map<string, ((message: string) => void)[]>();

  relay(): PubSubRelay {
    return {
      publish: (channel, message) => {
        this.published.push(message);
        for (const listener of this.#listeners.get(channel) ?? []) {
          listener(message);
        }
      },
      subscribe: (channel, listener) => {
        const existing = this.#listeners.get(channel);
        if (existing) existing.push(listener);
        else this.#listeners.set(channel, [listener]);
      },
    };
  }
}

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

describe('the relay frame', () => {
  it('round-trips a text payload with its origin and topic', () => {
    const frame = decodeRelay(encodeRelay('node-a', 'lobby', 'hello'));
    expect(frame).toEqual({ origin: 'node-a', topic: 'lobby', data: 'hello' });
  });

  it('round-trips binary through a text channel', () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    const data = decodeRelay(encodeRelay('node-a', 'lobby', bytes))?.data;
    expect(data).toBeInstanceOf(Uint8Array);
    expect([...(data as Uint8Array)]).toEqual([0, 1, 254, 255]);
  });

  it('round-trips a view that is a window onto a larger buffer', () => {
    const view = new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 4);
    const data = decodeRelay(encodeRelay('node-a', 'lobby', view))?.data;
    expect([...(data as Uint8Array)]).toEqual([8, 7, 6]);
  });

  it('ignores anything that is not one of our frames', () => {
    expect(decodeRelay('not json')).toBeUndefined();
    expect(decodeRelay('"a string"')).toBeUndefined();
    expect(decodeRelay('{"o":"a","t":"b"}')).toBeUndefined();
    expect(decodeRelay('{"o":1,"t":"b","d":"c"}')).toBeUndefined();
  });
});

describe('PubSub without a relay', () => {
  it('publishes to this process only and touches nothing else', async () => {
    const app = await HttpFactory.create(AppModule, { requestLogging: false });
    const url = await app.listen(0);
    try {
      const pubsub = app.get(PubSub);
      expect(pubsub.relaying).toBe(false);

      const client = await open(url);
      pubsub.publishEvent(TOPIC, 'said', 'local');
      await until(() => client.frames.length === 1);
      await Bun.sleep(100);
      expect(client.frames).toEqual([
        JSON.stringify({ event: 'said', data: 'local' }),
      ]);
      client.close();
    } finally {
      await app.shutdown();
    }
  });
});

describe('two nodes over an in-memory relay', () => {
  it('delivers a publish exactly once to every subscriber on both nodes', async () => {
    const bus = new Bus();
    const { apps, urls } = await twoNodes(bus.relay(), bus.relay(), 'test');
    const [first, second] = apps;
    const [urlA, urlB] = urls;
    if (!first || !second || !urlA || !urlB)
      throw new Error('two nodes expected');

    try {
      expect(first.get(PubSub).relaying).toBe(true);
      // The origin is per process instance, and it is what tells a node's own
      // echoed frame apart from a peer's.
      expect(first.get(PubSub).origin).not.toBe(second.get(PubSub).origin);

      const [ada, grace] = await Promise.all([
        open(urlA),
        open(urlA),
        open(urlB),
      ]).then(([a, b, c]) => [a, b, c] as const);
      const onB = grace;
      if (!ada || !onB) throw new Error('clients expected');

      first.get(PubSub).publishEvent(TOPIC, 'said', 'crosses nodes');
      const expected = JSON.stringify({
        event: 'said',
        data: 'crosses nodes',
      });

      // Wait for the far node, then keep waiting: a duplicate would arrive after
      // the first frame, so counting immediately would not see it.
      await until(() => onB.frames.length > 0);
      await Bun.sleep(150);

      for (const [name, client] of [
        ['a client on the publishing node', ada],
        ['a client on the other node', onB],
      ] as const) {
        expect(client.frames, name).toEqual([expected]);
      }

      // One frame on the channel. A node that re-relayed what it received would
      // have put a second one there - and then a third, forever.
      expect(bus.published).toHaveLength(1);

      for (const client of [ada, onB]) client.close();
    } finally {
      await stop(apps);
    }
  });

  it('rejects a second relay rather than subscribing twice', async () => {
    const bus = new Bus();
    const app = await HttpFactory.create(AppModule, {
      requestLogging: false,
      relay: bus.relay(),
    });
    await app.listen(0);
    try {
      const error = await app
        .get(PubSub)
        .relayThrough(bus.relay())
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );
      expect((error as Error).message).toMatch(/already relays/);
    } finally {
      await app.shutdown();
    }
  });
});

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

/**
 * A relay whose boot `subscribe` failed used to be retried by nothing: the node
 * reported the failure once and then silently never received a relayed message
 * again, for the life of the process. Publishing kept working, which is what made
 * it hard to notice - fan-out looked one-way rather than broken.
 */
describe('a boot subscribe that fails', () => {
  const failing = (failures: number) => {
    const state = { attempts: 0, subscribed: false, reported: [] as unknown[] };
    const relay: PubSubRelay = {
      publish: () => 0,
      subscribe: () => {
        state.attempts += 1;
        if (state.attempts <= failures) throw new Error('broker down');
        state.subscribed = true;
        return undefined;
      },
    };
    const onError = (error: unknown): void => {
      state.reported.push(error);
    };
    return { relay, state, onError };
  };

  it('retries until it succeeds', async () => {
    const pubsub = new PubSub();
    const { relay, state, onError } = failing(2);

    await pubsub.relayThrough(relay, {
      onError,
      resubscribe: { attempts: 5, delayMs: 1 },
    });
    expect(state.subscribed).toBe(false);

    expect(state.reported).toHaveLength(1);

    await Bun.sleep(60);
    expect(state.subscribed).toBe(true);
    expect(state.attempts).toBe(3);
    // Reported once when it started failing, not once per retry.
    expect(state.reported).toHaveLength(1);
    await pubsub.close();
  });

  it('gives up after the configured number of attempts', async () => {
    const pubsub = new PubSub();
    const { relay, state, onError } = failing(Number.POSITIVE_INFINITY);

    await pubsub.relayThrough(relay, {
      onError,
      resubscribe: { attempts: 2, delayMs: 1 },
    });
    await Bun.sleep(60);

    // The first call plus two retries, and then it stops rather than spinning.
    expect(state.attempts).toBe(3);
    await pubsub.close();
  });

  it('stops retrying once closed', async () => {
    const pubsub = new PubSub();
    const { relay, state, onError } = failing(Number.POSITIVE_INFINITY);

    await pubsub.relayThrough(relay, {
      onError,
      resubscribe: { attempts: 10, delayMs: 5 },
    });
    await pubsub.close();
    const afterClose = state.attempts;

    await Bun.sleep(40);
    expect(state.attempts).toBe(afterClose);
  });

  it('does not retry when retries are turned off', async () => {
    const pubsub = new PubSub();
    const { relay, state, onError } = failing(Number.POSITIVE_INFINITY);

    await pubsub.relayThrough(relay, {
      onError,
      resubscribe: { attempts: 0 },
    });
    await Bun.sleep(30);

    expect(state.attempts).toBe(1);
    await pubsub.close();
  });
});
