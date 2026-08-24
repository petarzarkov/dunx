import { AppFactory, inject, Module, provide, token } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { RedisConnection } from './connection.js';
import { RedisError, RedisErrorCode } from './errors.js';
import { redisConnection, RedisModule } from './module.js';
import { defaultRedisUrl, RedisOptions } from './options.js';

// Nothing here needs a server: Bun.RedisClient connects lazily, so a container
// can be built and torn down against an address that is never dialled.
const unreachable = 'redis://127.0.0.1:6399';

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error.message;
};

describe('RedisModule.forRoot', () => {
  it('binds RedisConnection and RedisOptions', async () => {
    const app = await AppFactory.create(
      RedisModule.forRoot({ url: unreachable }),
    );
    expect(app.get(RedisConnection)).toBeInstanceOf(RedisConnection);
    expect(app.get(RedisOptions).url).toBe(unreachable);
    await app.shutdown();
  });

  /**
   * The reason the connection is bound with `useFactory` and an explicit `inject`
   * instead of `useClass: Redis`. `@dunx/transform` only transforms `.ts` outside
   * `node_modules`, so it never sees this package's published `dist`, and a
   * `useClass` binding would fail at boot for every consumer. There is no compiler
   * preload configured for this test run, which is exactly the situation.
   */
  it('boots with no @dunx/transform preload registered', async () => {
    expect(
      globalThis[Symbol.for('dunx.deps') as unknown as never],
    ).toBeUndefined();
    const app = await AppFactory.create(
      RedisModule.forRoot({ url: unreachable }),
    );
    expect(app.get(RedisConnection).connected).toBe(false);
    await app.shutdown();
  });

  it('is importable from another module', async () => {
    @Module({ imports: [RedisModule.forRoot({ url: unreachable })] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(RedisConnection)).toBeInstanceOf(RedisConnection);
    await app.shutdown();
  });

  it('validates the url while the module is being configured, not at connect', () => {
    expect(() => RedisModule.forRoot({ url: 'http://localhost' })).toThrow(
      RedisError,
    );
  });

  it('reaches the connection from a service by constructor type', async () => {
    class Cache {
      constructor(readonly redis: RedisConnection) {}
    }
    // Stands in for what the compiler records; this test run has no preload.
    Object.defineProperty(Cache, Symbol.for('dunx.deps'), {
      value: () => [RedisConnection],
    });

    @Module({
      imports: [RedisModule.forRoot({ url: unreachable })],
      providers: [Cache],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Cache).redis).toBe(app.get(RedisConnection));
    await app.shutdown();
  });
});

describe('RedisModule.forRootAsync', () => {
  it('awaits the factory before anything is constructed', async () => {
    @Module({
      imports: [
        RedisModule.forRootAsync(async () => {
          await Bun.sleep(1);
          return { url: unreachable };
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(RedisOptions).url).toBe(unreachable);
    expect(app.get(RedisConnection)).toBeInstanceOf(RedisConnection);
    await app.shutdown();
  });

  it('accepts a synchronous factory too', async () => {
    const app = await AppFactory.create(
      RedisModule.forRootAsync(() => ({ url: unreachable })),
    );
    expect(app.get(RedisOptions).url).toBe(unreachable);
    await app.shutdown();
  });

  it('surfaces a bad url from the factory as a boot failure', async () => {
    const message = await rejectionMessage(
      AppFactory.create(RedisModule.forRootAsync(() => ({ url: 'nope' }))),
    );
    expect(message).toContain('not a valid URL');
  });

  /**
   * The scoped-container case: this dynamic module is its own scope, so a factory
   * cannot see a provider merely because the module calling `forRootAsync` imports
   * it. A token rather than a class, because an unbound class self-binds into
   * whichever scope asks first and would resolve with or without the fix.
   */
  it('injects from a module named in its own imports', async () => {
    const URL_TOKEN = token<string>('RedisUrl');

    @Module({
      providers: [provide(URL_TOKEN, { useValue: unreachable })],
      exports: [URL_TOKEN],
    })
    class UrlModule {}

    const app = await AppFactory.create(
      RedisModule.forRootAsync({
        imports: [UrlModule],
        useFactory: (url: string) => ({ url }),
        inject: [URL_TOKEN],
      }),
    );

    expect(app.get(RedisOptions).url).toBe(unreachable);
    await app.shutdown();
  });

  it('forwards those imports to a named connection too', async () => {
    const URL_TOKEN = token<string>('RedisUrl');

    @Module({
      providers: [provide(URL_TOKEN, { useValue: unreachable })],
      exports: [URL_TOKEN],
    })
    class UrlModule {}

    const app = await AppFactory.create(
      RedisModule.forRootAsync(
        {
          imports: [UrlModule],
          useFactory: (url: string) => ({ url }),
          inject: [URL_TOKEN],
        },
        'sessions',
      ),
    );

    expect(app.get(redisConnection('sessions'))).toBeInstanceOf(
      RedisConnection,
    );
    await app.shutdown();
  });

  it('binds a named token when given a name', async () => {
    const app = await AppFactory.create(
      RedisModule.forRootAsync(() => ({ url: unreachable }), 'late'),
    );
    expect(app.get(redisConnection('late'))).toBeInstanceOf(RedisConnection);
    await app.shutdown();
  });
});

describe('named connections', () => {
  // token() returns a fresh object per call, so without memoisation the module
  // and the consumer would hold different tokens for the same name.
  it('returns the same token for the same name', () => {
    expect(redisConnection('cache')).toBe(redisConnection('cache'));
    expect(redisConnection('cache')).not.toBe(redisConnection('sessions'));
    expect(redisConnection('cache').description).toBe('RedisConnection(cache)');
  });

  /**
   * The container binds any unbound class to itself, so asking for the contract
   * when only a named connection exists would otherwise return a bare
   * `RedisConnection` with every method undefined. The guard in its constructor is
   * what turns that into a message naming the fix.
   */
  it('does not claim RedisConnection or RedisOptions', async () => {
    const app = await AppFactory.create(
      RedisModule.forRoot({ url: unreachable, name: 'cache' }),
    );
    expect(app.get(redisConnection('cache'))).toBeInstanceOf(RedisConnection);
    expect(() => app.get(RedisConnection)).toThrow(
      /RedisConnection is a contract/,
    );
    // RedisOptions is genuinely constructible, so self-binding yields defaults
    // rather than an error - what matters is that it is not the named config.
    expect(app.get(RedisOptions).url).toBe(defaultRedisUrl());
    await app.shutdown();
  });

  it('lets two named connections coexist with a default one', async () => {
    @Module({
      imports: [
        RedisModule.forRoot({ url: unreachable }),
        RedisModule.forRoot({ url: unreachable, name: 'cache' }),
        RedisModule.forRoot({ url: 'redis://127.0.0.1:6398', name: 'jobs' }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const cache = app.get(redisConnection('cache'));
    const jobs = app.get(redisConnection('jobs'));
    expect(cache).not.toBe(jobs);
    expect(cache).not.toBe(app.get(RedisConnection));
    await app.shutdown();
  });

  it('is injectable with inject() in a field initialiser', async () => {
    class Sessions {
      readonly redis = inject(redisConnection('sessions'));
    }

    @Module({
      imports: [RedisModule.forRoot({ url: unreachable, name: 'sessions' })],
      providers: [Sessions],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Sessions).redis).toBe(app.get(redisConnection('sessions')));
    await app.shutdown();
  });

  /**
   * Two registrations of one name used to be a duplicate-binding boot error. They are
   * now two scopes, so the importer sees the same token from both and is **warned**
   * rather than silently given whichever was reached first.
   */
  it('warns when one name is registered twice', async () => {
    @Module({
      imports: [
        RedisModule.forRoot({ url: unreachable, name: 'dupe' }),
        RedisModule.forRoot({ url: unreachable, name: 'dupe' }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.warnings.join('\n')).toMatch(
      /imports .* from both "RedisModule" and "RedisModule"/,
    );
    await app.shutdown();
  });
});

describe('lifecycle', () => {
  it('closes the connection on shutdown, and tolerates a second shutdown', async () => {
    const app = await AppFactory.create(
      RedisModule.forRoot({ url: unreachable }),
    );
    const redis = app.get(RedisConnection);
    await app.shutdown();
    expect(redis.connected).toBe(false);
    await app.shutdown();
    await app.closed;
  });

  it('rejects commands once shut down', async () => {
    const app = await AppFactory.create(
      RedisModule.forRoot({
        url: unreachable,
        enableOfflineQueue: false,
        autoReconnect: false,
        maxRetries: 0,
      }),
    );
    const redis = app.get(RedisConnection);
    await app.shutdown();

    const error = await redis.get('anything').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RedisError);
    expect((error as RedisError).code).toBe(RedisErrorCode.CONNECTION_CLOSED);
    expect((error as RedisError).command).toBe('GET');
  });

  it('fails the boot when eager is set and the server is unreachable', async () => {
    const message = await rejectionMessage(
      AppFactory.create(
        RedisModule.forRoot({
          url: unreachable,
          eager: true,
          connectionTimeout: 300,
          autoReconnect: false,
          enableOfflineQueue: false,
          maxRetries: 0,
        }),
      ),
    );
    expect(message).toContain('CONNECT');
  });

  it('boots without touching the server when eager is not set', async () => {
    const app = await AppFactory.create(
      RedisModule.forRoot({
        url: unreachable,
        connectionTimeout: 300,
        autoReconnect: false,
        enableOfflineQueue: false,
        maxRetries: 0,
      }),
    );
    expect(app.get(RedisConnection).connected).toBe(false);
    await app.shutdown();
  });

  it('unsubscribing a channel that was never subscribed is a no-op', async () => {
    const app = await AppFactory.create(
      RedisModule.forRoot({ url: unreachable }),
    );
    // No subscriber connection exists yet, so this must not dial one just to
    // send UNSUBSCRIBE - Bun would throw ERR_REDIS_INVALID_STATE.
    await app.get(RedisConnection).unsubscribe('never');
    await app.shutdown();
  });
});
