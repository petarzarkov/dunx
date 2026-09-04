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
    // Bun does not fire `onconnect` on a natively duplicated client. Its
    // `_scheduleReconnect` wires `onconnect` and calls `connect()`, so a native
    // duplicate leaves `_handleConnected()` unrun: no `CLIENT SETNAME`, `ready`
    // never flips, and the worker awaiting readiness never blocks on the marker
    // again. Silently - nothing on that path rejects.
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
