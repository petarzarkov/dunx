import { describe, expect, it } from 'bun:test';
import { ConsoleLogger, Module } from '@dunx/core';
import { UNMATCHED, type MetaKey } from '../route/metadata.js';
import { Controller, Get, Post } from '../route/decorators.js';
import { ClientAddress } from '../server/client-address.js';
import type { RouteContext } from '../server/context.js';
import { HttpFactory } from '../server/factory.js';
import { SkipThrottle, Throttle } from './decorators.js';
import { ThrottleGuard } from './guard.js';
import { ThrottleModule } from './module.js';
import { ThrottleOptions } from './options.js';
import {
  MemoryThrottleStore,
  RedisThrottleStore,
  ThrottleStore,
  type ThrottleRedis,
} from './store.js';

/** A Redis that answers, so the multi-process path is exercised without one. */
class FakeRedis implements ThrottleRedis {
  readonly counts = new Map<string, number>();
  readonly expiries = new Map<string, number>();
  expireCalls = 0;

  incr(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return Promise.resolve(next);
  }

  expire(key: string, seconds: number): Promise<unknown> {
    this.expireCalls += 1;
    this.expiries.set(key, seconds);
    return Promise.resolve(true);
  }

  ttl(key: string): Promise<number> {
    return Promise.resolve(this.expiries.get(key) ?? -2);
  }
}

class BrokenRedis implements ThrottleRedis {
  incr(): Promise<number> {
    return Promise.reject(new Error('Connection closed'));
  }
  expire(): Promise<unknown> {
    return Promise.reject(new Error('Connection closed'));
  }
  ttl(): Promise<number> {
    return Promise.reject(new Error('Connection closed'));
  }
}

class Counting extends ConsoleLogger {
  warnings = 0;
  override warn(): void {
    this.warnings += 1;
  }
}

describe('ThrottleOptions', () => {
  const base = { limit: 2, windowSeconds: 60 };

  it('refuses an empty prefix rather than inventing one', () => {
    expect(() => new ThrottleOptions({ ...base, prefix: '' })).toThrow(
      /needs a prefix/,
    );
    expect(() => new ThrottleOptions({ ...base, prefix: '   ' })).toThrow(
      /needs a prefix/,
    );
  });

  it('refuses a limit or a window below one', () => {
    expect(
      () => new ThrottleOptions({ ...base, limit: 0, prefix: 'app' }),
    ).toThrow(/limit of at least 1/);
    expect(
      () => new ThrottleOptions({ ...base, windowSeconds: 0, prefix: 'app' }),
    ).toThrow(/windowSeconds of at least 1/);
  });

  it('sends headers unless told not to', () => {
    expect(new ThrottleOptions({ ...base, prefix: 'app' }).headers).toBe(true);
    expect(
      new ThrottleOptions({ ...base, prefix: 'app', headers: false }).headers,
    ).toBe(false);
  });
});

describe('RedisThrottleStore', () => {
  it('expires only on the hit that created the key', async () => {
    const redis = new FakeRedis();
    const store = new RedisThrottleStore(redis);
    expect(await store.hit('k', 60)).toBe(1);
    expect(await store.hit('k', 60)).toBe(2);
    expect(await store.hit('k', 60)).toBe(3);
    // A second EXPIRE would push the window forward on every request, which is a
    // window that never ends.
    expect(redis.expireCalls).toBe(1);
  });

  it('reads a missing or immortal key as no window rather than a negative wait', async () => {
    const store = new RedisThrottleStore(new FakeRedis());
    expect(await store.ttl('never-set')).toBeUndefined();
  });
});

describe('MemoryThrottleStore', () => {
  it('counts within a window and starts over after it', async () => {
    const store = new MemoryThrottleStore();
    expect(await store.hit('k', 1)).toBe(1);
    expect(await store.hit('k', 1)).toBe(2);
    expect(await store.ttl('k')).toBe(1);
    await Bun.sleep(1100);
    expect(await store.hit('k', 1)).toBe(1);
  });

  it('stays bounded when every key is a fresh subject', async () => {
    const store = new MemoryThrottleStore(4);
    for (let i = 0; i < 40; i += 1) await store.hit(`k${i}`, 60);
    // Nothing has expired, so the sweep clears rather than growing without limit.
    expect(await store.hit('k39', 60)).toBeLessThanOrEqual(2);
  });

  it('is a contract, and says so when asked to be an implementation', () => {
    expect(() => new (ThrottleStore as unknown as new () => unknown)()).toThrow(
      /contract, not an implementation/,
    );
  });
});

const server = async (init: {
  limit: number;
  windowSeconds: number;
  prefix?: string;
  headers?: boolean;
  store?: ThrottleStore;
  subject?: ThrottleOptions['subject'];
}) => {
  @Controller('/things')
  class Things {
    @Get('/')
    list(): { ok: boolean } {
      return { ok: true };
    }

    @Post('/')
    create(): { ok: boolean } {
      return { ok: true };
    }

    @Get('/tight')
    @Throttle({ limit: 1, windowSeconds: 60 })
    tight(): { ok: boolean } {
      return { ok: true };
    }

    @Get('/free')
    @SkipThrottle()
    free(): { ok: boolean } {
      return { ok: true };
    }
  }

  @Module({
    imports: [
      ThrottleModule.forRoot({
        limit: init.limit,
        windowSeconds: init.windowSeconds,
        prefix: init.prefix ?? 'test-app',
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.store === undefined ? {} : { store: init.store }),
        ...(init.subject === undefined ? {} : { subject: init.subject }),
      }),
    ],
    controllers: [Things],
  })
  class Root {}

  const app = await HttpFactory.create(Root, {
    middleware: [ThrottleGuard],
    requestLogging: false,
    bootLogging: false,
  });
  const base = await app.listen(0);
  return { app, base };
};

describe('ThrottleGuard', () => {
  it('allows the budget and then answers 429 with Retry-After', async () => {
    const { app, base } = await server({
      limit: 2,
      windowSeconds: 60,
      store: new RedisThrottleStore(new FakeRedis()),
    });

    const first = await fetch(`${base}things`);
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-limit')).toBe('2');
    expect(first.headers.get('ratelimit-remaining')).toBe('1');

    expect((await fetch(`${base}things`)).status).toBe(200);

    const refused = await fetch(`${base}things`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(refused.headers.get('ratelimit-remaining')).toBe('0');
    expect(await refused.json()).toMatchObject({ status: 429 });

    await app.shutdown();
  });

  it('counts per handler, so two verbs on one path do not share a budget', async () => {
    const { app, base } = await server({ limit: 1, windowSeconds: 60 });
    expect((await fetch(`${base}things`)).status).toBe(200);
    expect((await fetch(`${base}things`, { method: 'POST' })).status).toBe(201);
    expect((await fetch(`${base}things`)).status).toBe(429);
    await app.shutdown();
  });

  it("lets a handler's own @Throttle replace the default", async () => {
    const { app, base } = await server({ limit: 10, windowSeconds: 60 });
    expect((await fetch(`${base}things/tight`)).status).toBe(200);
    expect((await fetch(`${base}things/tight`)).status).toBe(429);
    await app.shutdown();
  });

  it('exempts a @SkipThrottle handler entirely', async () => {
    const { app, base } = await server({ limit: 1, windowSeconds: 60 });
    for (let i = 0; i < 5; i += 1) {
      expect((await fetch(`${base}things/free`)).status).toBe(200);
    }
    await app.shutdown();
  });

  /**
   * The miss carries `UNMATCHED`, and counting it would let a burst of 404s spend a
   * real caller's budget for one Redis round trip each.
   */
  it('does not spend a budget on an unmatched path', async () => {
    const redis = new FakeRedis();
    const { app, base } = await server({
      limit: 1,
      windowSeconds: 60,
      store: new RedisThrottleStore(redis),
    });
    for (let i = 0; i < 3; i += 1) {
      expect((await fetch(`${base}nope`)).status).toBe(404);
    }
    expect(redis.counts.size).toBe(0);
    expect((await fetch(`${base}things`)).status).toBe(200);
    await app.shutdown();
  });

  it('counts by the subject the app names', async () => {
    const redis = new FakeRedis();
    const { app, base } = await server({
      limit: 1,
      windowSeconds: 60,
      store: new RedisThrottleStore(redis),
      subject: (req) => req.headers.get('x-user') ?? undefined,
    });
    expect(
      (await fetch(`${base}things`, { headers: { 'x-user': 'a' } })).status,
    ).toBe(200);
    expect(
      (await fetch(`${base}things`, { headers: { 'x-user': 'b' } })).status,
    ).toBe(200);
    expect(
      (await fetch(`${base}things`, { headers: { 'x-user': 'a' } })).status,
    ).toBe(429);
    expect([...redis.counts.keys()]).toEqual([
      'test-app:throttle:Things:list:a',
      'test-app:throttle:Things:list:b',
    ]);
    await app.shutdown();
  });

  it('sends no rate-limit headers when headers is false', async () => {
    const { app, base } = await server({
      limit: 1,
      windowSeconds: 60,
      headers: false,
    });
    const ok = await fetch(`${base}things`);
    expect(ok.headers.get('ratelimit-limit')).toBeNull();
    const refused = await fetch(`${base}things`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeNull();
    await app.shutdown();
  });
});

const contextOf = (overrides: Partial<Record<'unmatched', boolean>> = {}) => {
  const ctx: RouteContext = {
    controller: 'Things',
    handler: 'list',
    method: 'GET',
    path: '/things',
    parsesBody: false,
    get: <T>(key: MetaKey<T>): T | undefined =>
      key.id === UNMATCHED.id && overrides.unmatched === true
        ? (true as T)
        : undefined,
  };
  return ctx;
};

describe('ThrottleGuard, against a counter that is down', () => {
  /**
   * An unreachable counter degrades the route and never the process, and it warns
   * **once** - a line per request would be its own outage.
   */
  it('fails open and warns once per process', async () => {
    const logger = new Counting();
    const guard = new ThrottleGuard(
      new ThrottleOptions({
        limit: 1,
        windowSeconds: 60,
        prefix: 'app',
        subject: () => 'unit',
      }),
      new RedisThrottleStore(new BrokenRedis()),
      new ClientAddress(),
      logger,
    );
    const req = new Request('http://x/things') as never;
    const ok = () => Promise.resolve(new Response('ok'));

    for (let i = 0; i < 4; i += 1) {
      expect((await guard.handle(req, contextOf(), ok)).status).toBe(200);
    }
    expect(logger.warnings).toBe(1);
  });

  it('skips an unmatched path before it ever reaches the store', async () => {
    const logger = new Counting();
    const guard = new ThrottleGuard(
      new ThrottleOptions({
        limit: 1,
        windowSeconds: 60,
        prefix: 'app',
        subject: () => 'unit',
      }),
      new RedisThrottleStore(new BrokenRedis()),
      new ClientAddress(),
      logger,
    );
    const response = await guard.handle(
      new Request('http://x/nope') as never,
      contextOf({ unmatched: true }),
      () => Promise.resolve(new Response('miss', { status: 404 })),
    );
    expect(response.status).toBe(404);
    // Nothing was counted, so nothing failed and nothing warned.
    expect(logger.warnings).toBe(0);
  });
});
