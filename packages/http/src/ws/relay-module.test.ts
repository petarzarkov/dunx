import { describe, expect, it } from 'bun:test';
import { AppFactory, Module, provide, token } from '@dunx/core';
import { RedisRelay } from './redis-relay.js';
import { RelayConnectionOptions, WsRelayModule } from './relay-module.js';

// Nothing here dials: `Bun.RedisClient` connects lazily, so a container can be
// built and torn down against an address nothing is listening on.
const unreachable = 'redis://127.0.0.1:6399';

describe('WsRelayModule', () => {
  it('binds the relay as a class, so it can be a parameter', async () => {
    @Module({ imports: [WsRelayModule.forRoot({ url: unreachable })] })
    class Root {}

    const app = await AppFactory.create(Root);
    // A class, not a token: this is what lets an `HttpOptionsProvider` subclass
    // take the relay as a constructor parameter instead of `main.ts` building one.
    expect(app.get(RedisRelay)).toBeInstanceOf(RedisRelay);
    await app.shutdown();
  });

  it('strips the password from the url it reports', async () => {
    @Module({
      imports: [
        WsRelayModule.forRoot({ url: 'redis://user:hunter2@127.0.0.1:6399' }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(RedisRelay).url).not.toContain('hunter2');
    await app.shutdown();
  });

  it('reads its settings from a factory', async () => {
    @Module({
      imports: [
        WsRelayModule.forRootAsync({
          useFactory: () => ({ url: unreachable, connectionTimeout: 250 }),
          inject: [] as const,
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(RelayConnectionOptions).connectionTimeout).toBe(250);
    await app.shutdown();
  });

  it('reaches a provider its own imports export', async () => {
    // A `token()`, never a class: an unbound class self-binds into whichever
    // scope asks first, so it would resolve whether or not `imports` reached the
    // factory and the test would pass against the bug it guards.
    const RELAY_URL = token<string>('RelayUrl');

    @Module({
      providers: [provide(RELAY_URL, { useValue: unreachable })],
      exports: [RELAY_URL],
    })
    class UrlModule {}

    @Module({
      imports: [
        WsRelayModule.forRootAsync({
          imports: [UrlModule],
          useFactory: (url: string) => ({ url, connectionTimeout: 125 }),
          inject: [RELAY_URL] as const,
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(RelayConnectionOptions).connectionTimeout).toBe(125);
    expect(app.get(RedisRelay).url).toContain('6399');
    await app.shutdown();
  });

  it('leaves each RedisRelay default alone for a setting nobody passed', async () => {
    @Module({ imports: [WsRelayModule.forRoot({ url: unreachable })] })
    class Root {}

    const app = await AppFactory.create(Root);
    // `toInit()` emits only the keys that were set, so `maxRetries` stays at
    // `RedisRelay`'s own 0 rather than arriving as an explicit `undefined`.
    expect(app.get(RelayConnectionOptions).toInit()).toEqual({
      url: unreachable,
    });
    await app.shutdown();
  });

  it('closes the relay it built when the app shuts down', async () => {
    @Module({ imports: [WsRelayModule.forRoot({ url: unreachable })] })
    class Root {}

    const app = await AppFactory.create(Root);
    const relay = app.get(RedisRelay);
    let closed = false;
    const original = relay.close.bind(relay);
    relay.close = async (): Promise<void> => {
      closed = true;
      await original();
    };

    await app.shutdown();

    // `PubSub.close()` only closes a relay it was handed, and an app that never
    // opened a socket never reaches it. A relay the container built is the
    // container's to close.
    expect(closed).toBe(true);
  });
});
