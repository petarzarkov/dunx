import { describe, expect, it } from 'bun:test';
import { ConsoleLogger, AsyncRequestContext } from '@dunx/core';
import { QueueConnection } from './connection.js';
import { QueueOptions } from './options.js';

/**
 * The `duplicate` wrapper, which is the whole reason this class exists and the
 * place a one-line slip cost `getWorkers()` for every dunx app.
 */
const connection = (): QueueConnection =>
  new QueueConnection(
    new QueueOptions({
      url: 'redis://127.0.0.1:1',
      connection: {
        connectionTimeout: 50,
        maxRetries: 0,
        autoReconnect: false,
      },
    }),
    new ConsoleLogger(new AsyncRequestContext()),
  );

describe('the duplicate wrapper', () => {
  it('forwards its arguments, which is what names a worker connection', () => {
    // bullmq's Bun adapter takes the connection name **only** through
    // `duplicate({ connectionName })` - its constructor ignores the option - and
    // `Queue.getWorkers()` finds workers by matching that name in `CLIENT LIST`.
    // This wrapper used to call `duplicate.call(adapter)` with nothing, so
    // `CLIENT SETNAME` never ran and a live worker reported as absent. Measured
    // against a real Redis: 0 workers before, 1 after.
    const source = connection();
    const adapter = source.client() as unknown as {
      duplicate: (...args: unknown[]) => { connectionName?: string };
    };

    const duplicated = adapter.duplicate({ connectionName: 'bull:cXVldWU=' });
    expect(duplicated.connectionName).toBe('bull:cXVldWU=');

    source.onShutdown();
  });

  it('still attaches an error listener to whatever duplicate returns', () => {
    // The original reason for the wrapper: an `error` event on a listener-less
    // emitter throws rather than being ignored, and bullmq duplicates the client
    // for connections it may block on.
    const source = connection();
    const adapter = source.client() as unknown as {
      duplicate: (...args: unknown[]) => {
        listenerCount(event: string): number;
      };
    };

    expect(adapter.duplicate().listenerCount('error')).toBeGreaterThan(0);
    source.onShutdown();
  });
});

describe('the raw client bullmq reconnects with', () => {
  it('duplicates by construction, so the reconnect keeps its onconnect callback', async () => {
    // bullmq's `_duplicateRaw` prefers `src.duplicate()` over construction, and
    // Bun's `duplicate()` resolves an already-connected client, so `onconnect`
    // assigned after it never fires. A clean reset does not wedge 6.3.4, whose
    // `connect()` runs `_handleConnected()` itself; the override stays for the
    // production trigger a reset does not simulate. docs/architecture/queues.md
    // has both measurements. What this asserts is the part that is provable.
    const source = connection();
    const adapter = source.client() as unknown as { raw: Bun.RedisClient };
    const raw = adapter.raw;

    const duplicated = await raw.duplicate();

    // Constructed, not natively duplicated: same bound class, same target.
    expect(duplicated).toBeInstanceOf(
      raw.constructor as new (url?: string) => Bun.RedisClient,
    );
    expect((duplicated as { url?: string }).url).toBe('redis://127.0.0.1:1');

    duplicated.close();
    source.onShutdown();
  });

  it('survives a second reconnect, which is where a socket drop lands twice', async () => {
    // One dropped socket is not the failure - the replacement has to be able to
    // drop and be replaced too. A natively duplicated client is a plain
    // `Bun.RedisClient`, so the override is gone from it and the *next*
    // reconnect is the one that wedges. Measured in production: the first drop
    // recovered, the second left the queue silent until a restart.
    const source = connection();
    const adapter = source.client() as unknown as { raw: Bun.RedisClient };
    const bound = adapter.raw.constructor as new (
      url?: string,
    ) => Bun.RedisClient;

    const first = await adapter.raw.duplicate();
    const second = await first.duplicate();

    expect(second).toBeInstanceOf(bound);
    expect((second as { url?: string }).url).toBe('redis://127.0.0.1:1');

    second.close();
    first.close();
    source.onShutdown();
  });
});

/**
 * bullmq calls `duplicate()` for any connection it may block on - `Worker` and
 * `QueueEvents` each once, `Queue` never - and `#open` used to hold only the
 * clients `client()` built, so that socket had no teardown owner.
 *
 * Nothing here waits on a broker: a duplicate reports its own `disconnect`, and
 * whether it ever connected is irrelevant to who owns it.
 */
describe('duplicate ownership', () => {
  /** Replaces `disconnect` with a recorder, returning what it recorded. */
  const watchDisconnect = (client: unknown): { calls: number } => {
    const spy = { calls: 0 };
    const target = client as { disconnect: () => void };
    const inner = target.disconnect.bind(target);
    target.disconnect = (): void => {
      spy.calls += 1;
      inner();
    };
    return spy;
  };

  it('tears down a duplicate, which used to belong to nobody', () => {
    const source = connection();
    const client = source.client() as unknown as {
      duplicate: (options: unknown) => unknown;
    };
    const copy = client.duplicate({ connectionName: 'bull:cXVldWU=' });

    const watched = watchDisconnect(copy);
    source.onShutdown();

    expect(watched.calls).toBe(1);
  });

  it('tears down a duplicate of a duplicate', () => {
    const source = connection();
    const first = source.client() as unknown as {
      duplicate: (options: unknown) => { duplicate: (o: unknown) => unknown };
    };
    const second = first.duplicate({});
    const third = second.duplicate({});

    const watched = [watchDisconnect(second), watchDisconnect(third)];
    source.onShutdown();

    expect(watched.map((w) => w.calls)).toEqual([1, 1]);
  });

  it('tears down a duplicate that never got a socket', () => {
    // A duplicate is built with no `raw`: bullmq creates one from a `rawFactory`
    // on first connect. So teardown has to cope with there being nothing to
    // close, which is the case for every duplicate that never connected.
    const source = connection();
    const client = source.client() as unknown as {
      duplicate: (options: unknown) => { raw?: unknown };
    };
    const copy = client.duplicate({});

    expect(copy.raw).toBeUndefined();
    expect(() => source.onShutdown()).not.toThrow();
  });

  it('does not count an unconnected duplicate as an open socket', () => {
    const source = connection();
    const client = source.client() as unknown as {
      duplicate: (options: unknown) => unknown;
    };
    client.duplicate({});

    // Nothing reached the broker at `127.0.0.1:1`, so nothing is open - the
    // count is sockets, not adapters.
    expect(source.open).toBe(0);
    source.onShutdown();
  });

  it('forgets every adapter once shut down, so a second call is a no-op', () => {
    const source = connection();
    const client = source.client() as unknown as {
      duplicate: (options: unknown) => unknown;
    };
    const copy = client.duplicate({});

    source.onShutdown();
    const watched = watchDisconnect(copy);
    source.onShutdown();

    expect(watched.calls).toBe(0);
  });
});
