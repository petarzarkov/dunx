import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ConsoleLogger, Logger, Module, provide } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import type { Input, RouteSchemas } from '../route/schema.js';
import { HttpError } from '../server/errors.js';
import type { HttpApp } from '../server/factory.js';
import { HttpFactory } from '../server/factory.js';
import { Note } from '../server/schema.fixture.js';
import { Idempotent } from './decorators.js';
import { BoundIdempotencyGuard, IDEMPOTENT_REPLAYED_HEADER } from './guard.js';
import { IdempotencyModule } from './module.js';
import { IdempotencyOptions, type IdempotencyOptionsInit } from './options.js';
import {
  IdempotencyStore,
  MemoryIdempotencyStore,
  type IdempotencyClaim,
  type IdempotencyRecord,
  type StoredResponse,
} from './store.js';

const note = { body: Note } as const;
const runs = new Map<string, number>();
const ran = (name: string): number => {
  const next = (runs.get(name) ?? 0) + 1;
  runs.set(name, next);
  return next;
};

let release: () => void = () => undefined;

@Controller('/orders')
class Orders {
  @Idempotent()
  @Post('/', note)
  create(input: Input<typeof note>): { order: number; text: string } {
    return { order: ran('create'), text: input.body.text };
  }

  @Idempotent({ required: true })
  @Post('/strict', note)
  strict(input: Input<typeof note>): { text: string } {
    ran('strict');
    return { text: input.body.text };
  }

  /** No schema: the handler reads the request itself, after the guard did. */
  @Idempotent()
  @Post('/raw')
  async raw({
    req,
  }: Input<RouteSchemas>): Promise<{ echoed: string; order: number }> {
    return { echoed: await req.text(), order: ran('raw') };
  }

  @Idempotent()
  @Post('/throws')
  throws(): never {
    ran('throws');
    throw new HttpError(500, 'boom');
  }

  @Idempotent()
  @Post('/unavailable')
  unavailable(): Response {
    ran('unavailable');
    return new Response('later', { status: 503 });
  }

  @Idempotent()
  @Post('/rejected')
  rejected(): Response {
    ran('rejected');
    return Response.json({ reason: 'declined' }, { status: 402 });
  }

  @Idempotent()
  @Post('/slow')
  async slow(): Promise<{ order: number }> {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { order: ran('slow') };
  }

  @Idempotent()
  @Post('/headers')
  headers(): Response {
    ran('headers');
    const response = Response.json({ ok: true }, { status: 201 });
    response.headers.set('location', '/orders/7');
    response.headers.set('set-cookie', 'session=secret');
    return response;
  }

  @Idempotent()
  @Post('/empty')
  empty(): undefined {
    ran('empty');
    return undefined;
  }

  @Idempotent()
  @Post('/big')
  big(): Response {
    ran('big');
    return new Response('x'.repeat(4096));
  }

  @Idempotent({ ttlSeconds: 1 })
  @Post('/short')
  short(): { order: number } {
    return { order: ran('short') };
  }

  @Post('/plain', note)
  plain(input: Input<typeof note>): { order: number; text: string } {
    return { order: ran('plain'), text: input.body.text };
  }
}

/** Decorated twice: the handler's options win and the guard still runs once. */
@Idempotent()
@Controller('/wallets')
class Wallets {
  @Idempotent({ ttlSeconds: 60 })
  @Post('/', note)
  top(input: Input<typeof note>): { order: number; text: string } {
    return { order: ran('wallets'), text: input.body.text };
  }

  @Idempotent()
  @Post('/raw')
  raw(): { order: number } {
    return { order: ran('wallets-raw') };
  }
}

@Idempotent({ required: true })
@Controller('/carts')
class Carts {
  @Get('/')
  list(): { carts: number } {
    return { carts: ran('carts-list') };
  }

  @Post('/')
  add(): { order: number } {
    return { order: ran('carts-add') };
  }
}

const boot = async (
  init: Partial<IdempotencyOptionsInit> = {},
): Promise<{ app: HttpApp; base: string }> => {
  @Module({
    imports: [
      IdempotencyModule.forRoot({
        prefix: 'test-app',
        subject: () => undefined,
        maxBodyBytes: 1024,
        ...init,
      }),
    ],
    controllers: [Orders, Carts, Wallets],
  })
  class Root {}

  const app = await HttpFactory.create(Root, {
    requestLogging: false,
    bootLogging: false,
  });
  return { app, base: await app.listen(0) };
};

let app: HttpApp;
let base: string;

beforeAll(async () => {
  ({ app, base } = await boot({
    subject: (req) => req.headers.get('x-user') ?? undefined,
  }));
});

afterAll(async () => {
  await app.shutdown();
});

const orderOf = async (response: Response): Promise<number> =>
  ((await response.json()) as { order: number }).order;

const post = (
  path: string,
  key: string | undefined,
  body: string = JSON.stringify({ text: 'one' }),
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
      ...headers,
    },
    body,
  });

describe('@Idempotent()', () => {
  it('runs the first request, then replays it marked as a replay', async () => {
    const first = await post('orders', 'k-first');
    expect(first.status).toBe(201);
    expect(first.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    const body = await first.json();

    const again = await post('orders', 'k-first');
    expect(again.status).toBe(201);
    expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(again.headers.get('content-type')).toContain('application/json');
    expect(await again.json()).toEqual(body);
    expect(runs.get('create')).toBe(1);
  });

  it('accepts the Structured Field String form the draft specifies', async () => {
    const first = await post('orders', '"k-quoted"');
    const again = await post('orders', 'k-quoted');
    expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await again.json()).toEqual(await first.json());
  });

  it('answers 422 to the same key with a different body', async () => {
    await post('orders', 'k-mismatch');
    const other = await post('orders', 'k-mismatch', '{"text":"two"}');
    expect(other.status).toBe(422);
    expect(await other.json()).toMatchObject({ status: 422 });
  });

  it('answers 422 to the same key on a different route', async () => {
    await post('orders', 'k-route');
    expect((await post('orders/raw', 'k-route')).status).toBe(422);
  });

  it('answers 409 while the first request with the key is running', async () => {
    const first = post('orders/slow', 'k-slow');
    await Bun.sleep(20);
    const concurrent = await post('orders/slow', 'k-slow');
    expect(concurrent.status).toBe(409);
    release();
    expect((await first).status).toBe(201);
    expect(
      (await post('orders/slow', 'k-slow')).headers.get(
        IDEMPOTENT_REPLAYED_HEADER,
      ),
    ).toBe('true');
    expect(runs.get('slow')).toBe(1);
  });

  it('answers 400 to a missing key only where one is required', async () => {
    const missing = await post('orders/strict', undefined);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: expect.stringContaining('Idempotency-Key is missing'),
    });
    expect(runs.get('strict')).toBeUndefined();

    expect((await post('orders', undefined)).status).toBe(201);
    expect((await post('orders', undefined)).status).toBe(201);
  });

  it('answers 400 to a key that is not visible ASCII or is too long', async () => {
    expect((await post('orders', 'has space')).status).toBe(400);
    expect((await post('orders', 'x'.repeat(256))).status).toBe(400);
    expect((await post('orders', '""')).status).toBe(400);
  });

  it('runs a thrown error again on retry rather than replaying it', async () => {
    expect((await post('orders/throws', 'k-throw')).status).toBe(500);
    expect((await post('orders/throws', 'k-throw')).status).toBe(500);
    expect(runs.get('throws')).toBe(2);
  });

  it('runs a returned 5xx again on retry', async () => {
    expect((await post('orders/unavailable', 'k-503')).status).toBe(503);
    const retry = await post('orders/unavailable', 'k-503');
    expect(retry.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(runs.get('unavailable')).toBe(2);
  });

  it('replays a returned 4xx, which is an answer rather than a failure', async () => {
    expect((await post('orders/rejected', 'k-402')).status).toBe(402);
    const replay = await post('orders/rejected', 'k-402');
    expect(replay.status).toBe(402);
    expect(await replay.json()).toEqual({ reason: 'declined' });
    expect(runs.get('rejected')).toBe(1);
  });

  it('replays stored headers but never a cookie', async () => {
    const first = await post('orders/headers', 'k-headers');
    expect(first.headers.get('set-cookie')).toBe('session=secret');
    const replay = await post('orders/headers', 'k-headers');
    expect(replay.status).toBe(201);
    expect(replay.headers.get('location')).toBe('/orders/7');
    expect(replay.headers.get('set-cookie')).toBeNull();
  });

  it('replays an empty 204', async () => {
    expect((await post('orders/empty', 'k-empty')).status).toBe(204);
    const replay = await post('orders/empty', 'k-empty');
    expect(replay.status).toBe(204);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(runs.get('empty')).toBe(1);
  });

  it('returns a body over maxBodyBytes whole, but does not keep it', async () => {
    const first = await post('orders/big', 'k-big');
    expect((await first.text()).length).toBe(4096);
    const retry = await post('orders/big', 'k-big');
    expect((await retry.text()).length).toBe(4096);
    expect(retry.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(runs.get('big')).toBe(2);
  });

  it('leaves the body readable for a handler without a schema', async () => {
    const first = await post('orders/raw', 'k-raw', 'plain words');
    expect(await first.json()).toEqual({ echoed: 'plain words', order: 1 });
    const replay = await post('orders/raw', 'k-raw', 'plain words');
    expect(await replay.json()).toEqual({ echoed: 'plain words', order: 1 });
  });

  it('hands a form body it drained to the schema that parses it', async () => {
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    const first = await post('orders', 'k-form', 'text=from+a+form', form);
    expect(await first.json()).toMatchObject({ text: 'from a form' });
    const replay = await post('orders', 'k-form', 'text=from+a+form', form);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
  });

  it("keeps one caller's key apart from another's", async () => {
    const ada = await post('orders', 'k-shared', undefined, {
      'x-user': 'ada',
    });
    const bob = await post('orders', 'k-shared', undefined, {
      'x-user': 'bob',
    });
    expect(bob.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(await orderOf(bob)).not.toBe(await orderOf(ada));
  });

  it('honours a per-route ttlSeconds', async () => {
    const first = await (await post('orders/short', 'k-ttl')).json();
    expect(await (await post('orders/short', 'k-ttl')).json()).toEqual(first);
    await Bun.sleep(1100);
    expect(await (await post('orders/short', 'k-ttl')).json()).not.toEqual(
      first,
    );
  });

  it('leaves a route without the decorator untouched', async () => {
    const first = await post('orders/plain', 'k-plain');
    const second = await post('orders/plain', 'k-plain');
    expect(second.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(await orderOf(second)).toBe((await orderOf(first)) + 1);
  });

  it('runs once when both the controller and the handler are marked', async () => {
    for (const path of ['wallets', 'wallets/raw']) {
      const first = await post(path, `k-twice-${path}`);
      expect(first.status).toBe(201);
      const replay = await post(path, `k-twice-${path}`);
      expect(replay.status).toBe(201);
      expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    }
    expect(runs.get('wallets')).toBe(1);
    expect(runs.get('wallets-raw')).toBe(1);
  });

  it('covers a controller, skipping its GETs', async () => {
    expect((await fetch(`${base}carts`)).status).toBe(200);
    expect((await post('carts', undefined)).status).toBe(400);
    expect((await post('carts', 'k-cart')).status).toBe(201);
    expect(
      (await post('carts', 'k-cart')).headers.get(IDEMPOTENT_REPLAYED_HEADER),
    ).toBe('true');
    expect(runs.get('carts-add')).toBe(1);
  });
});

describe('IdempotencyModule', () => {
  it('shares one key space when the subject names nobody', async () => {
    const shared = await boot();
    const url = `${shared.base}orders`;
    const send = (user: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'idempotency-key': 'k-nobody', 'x-user': user },
        body: '{"text":"one"}',
      });
    await send('ada');
    expect((await send('bob')).headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe(
      'true',
    );
    await shared.app.shutdown();
  });

  it('builds its options in forRootAsync', async () => {
    @Module({
      imports: [
        IdempotencyModule.forRootAsync({
          useFactory: () =>
            Promise.resolve({ prefix: 'async-app', subject: () => undefined }),
        }),
      ],
      controllers: [Orders],
    })
    class Root {}
    const async = await HttpFactory.create(Root, {
      requestLogging: false,
      bootLogging: false,
    });
    expect(async.get(IdempotencyOptions).prefix).toBe('async-app');
    expect(async.get(IdempotencyStore)).toBeInstanceOf(MemoryIdempotencyStore);
    await async.shutdown();
  });

  it('refuses a missing prefix and a non-positive duration', () => {
    for (const prefix of [undefined, '', '  ']) {
      expect(
        () =>
          new IdempotencyOptions({
            prefix,
            subject: () => undefined,
          } as unknown as IdempotencyOptionsInit),
      ).toThrow(/needs a prefix/);
    }
    const subject = () => undefined;
    expect(
      () => new IdempotencyOptions({ prefix: 'a', subject, leaseSeconds: 0 }),
    ).toThrow(/leaseSeconds of at least 1/);
    expect(() => Idempotent({ ttlSeconds: 0.5 })).toThrow(
      /ttlSeconds of at least 1/,
    );
  });

  /** `undefined` is what a config read that found nothing hands over. */
  it('refuses a missing subject rather than defaulting to a shared key space', () => {
    expect(
      () =>
        new IdempotencyOptions({
          prefix: 'a',
        } as unknown as IdempotencyOptionsInit),
    ).toThrow(
      'IdempotencyModule needs a subject naming whose key it is, and it has no ' +
        'default. Pass subject: () => auth.current()?.user.id, or ' +
        'subject: () => undefined to share one key space between every caller.',
    );
  });

  it('fails at boot, naming the route and the fix, when nothing imports it', async () => {
    @Controller('/refunds')
    class Refunds {
      @Idempotent()
      @Post('/')
      refund(): undefined {
        return undefined;
      }
    }
    @Module({ controllers: [Refunds] })
    class Root {}
    const bare = await HttpFactory.create(Root, {
      requestLogging: false,
      bootLogging: false,
    });
    await expect(bare.listen(0)).rejects.toThrow(
      'Refunds.refund(): @Idempotent() needs IdempotencyModule.forRoot({ prefix, ' +
        'subject }) imported, and no module in this app imports it.',
    );
    await bare.shutdown();
  });
});

/** A store that is down for every call, or only from `complete` on. */
class DownStore extends IdempotencyStore {
  constructor(private readonly from: 'claim' | 'complete') {
    super();
  }
  claim(): Promise<boolean> {
    return this.from === 'claim'
      ? Promise.reject(new Error('Connection closed'))
      : Promise.resolve(true);
  }
  read(): Promise<IdempotencyRecord | undefined> {
    return Promise.resolve(undefined);
  }
  complete(
    _key: string,
    _claim: IdempotencyClaim,
    _response: StoredResponse,
  ): Promise<void> {
    return Promise.reject(new Error('Connection closed'));
  }
  release(): Promise<void> {
    return Promise.reject(new Error('Connection closed'));
  }
}

class Counting extends ConsoleLogger {
  warnings = 0;
  override warn(): void {
    this.warnings += 1;
  }
}

describe('IdempotencyGuard, against a store that is down', () => {
  const guarded = async (
    store: IdempotencyStore,
    logger: Counting,
  ): Promise<{ app: HttpApp; base: string }> => {
    @Module({
      imports: [
        IdempotencyModule.forRoot({
          prefix: 'down',
          subject: () => undefined,
          store,
        }),
      ],
      controllers: [Orders],
      providers: [provide(Logger, { useValue: logger })],
    })
    class Root {}
    const down = await HttpFactory.create(Root, {
      requestLogging: false,
      bootLogging: false,
    });
    return { app: down, base: await down.listen(0) };
  };

  it('fails closed with a 503 and never runs the handler', async () => {
    const logger = new Counting();
    const down = await guarded(new DownStore('claim'), logger);
    const before = runs.get('rejected') ?? 0;
    for (let i = 0; i < 2; i += 1) {
      const refused = await fetch(`${down.base}orders/rejected`, {
        method: 'POST',
        headers: { 'idempotency-key': 'k-down' },
      });
      expect(refused.status).toBe(503);
    }
    expect(runs.get('rejected') ?? 0).toBe(before);
    expect(logger.warnings).toBe(1);
    await down.app.shutdown();
  });

  it('still returns the response when storing it fails', async () => {
    const logger = new Counting();
    const down = await guarded(new DownStore('complete'), logger);
    const answered = await fetch(`${down.base}orders/rejected`, {
      method: 'POST',
      headers: { 'idempotency-key': 'k-late' },
    });
    expect(answered.status).toBe(402);
    expect(
      (
        await fetch(`${down.base}orders/throws`, {
          method: 'POST',
          headers: { 'idempotency-key': 'k-late-throw' },
        })
      ).status,
    ).toBe(500);
    expect(logger.warnings).toBe(1);
    await down.app.shutdown();
  });

  it('is a no-op for a route with no metadata, if listed globally', async () => {
    const guard = new BoundIdempotencyGuard(
      new IdempotencyOptions({ prefix: 'global', subject: () => undefined }),
      new DownStore('claim'),
      new Counting(),
    );
    const response = await guard.handle(
      new Request('http://x/') as never,
      {
        controller: 'X',
        handler: 'y',
        method: 'POST',
        path: '/',
        parsesBody: false,
        get: () => undefined,
      },
      () => Promise.resolve(new Response('through')),
    );
    expect(await response.text()).toBe('through');
  });
});
