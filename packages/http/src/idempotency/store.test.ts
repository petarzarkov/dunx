import { afterAll, describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Post } from '../route/decorators.js';
import { HttpFactory } from '../server/factory.js';
import { Idempotent } from './decorators.js';
import { IDEMPOTENT_REPLAYED_HEADER } from './guard.js';
import { IdempotencyModule } from './module.js';
import {
  IdempotencyStore,
  MemoryIdempotencyStore,
  RedisIdempotencyStore,
  type IdempotencyClaim,
  type StoredResponse,
} from './store.js';

const REDIS_URL = 'redis://localhost:6379';

const redisReachable = async (): Promise<boolean> => {
  const client = new Bun.RedisClient(REDIS_URL, { maxRetries: 0 });
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
const clients: Bun.RedisClient[] = [];
const redisClient = (): Bun.RedisClient => {
  const client = new Bun.RedisClient(REDIS_URL);
  clients.push(client);
  return client;
};

afterAll(() => {
  for (const client of clients) client.close();
});

const response: StoredResponse = {
  status: 201,
  headers: [['content-type', 'application/json']],
  body: new TextEncoder().encode('{"order":1}'),
};

const claimOf = (fingerprint = 'fp'): IdempotencyClaim => ({
  token: crypto.randomUUID(),
  fingerprint,
});

/** One contract, two stores: the guard cannot tell them apart. */
const contract = (name: string, make: () => IdempotencyStore) => {
  describe(name, () => {
    const key = () => `idem-test:${crypto.randomUUID()}`;

    it('lets exactly one of many concurrent claims win', async () => {
      const store = make();
      const k = key();
      const won = await Promise.all(
        Array.from({ length: 16 }, () => store.claim(k, claimOf(), 5000)),
      );
      expect(won.filter(Boolean)).toHaveLength(1);
      expect(await store.read(k)).toEqual({
        state: 'pending',
        fingerprint: 'fp',
      });
    });

    it('stores the response in place of the claim, bytes intact', async () => {
      const store = make();
      const k = key();
      const claim = claimOf('abc:def');
      expect(await store.claim(k, claim, 5000)).toBe(true);
      await store.complete(k, claim, response, 5000);
      const record = await store.read(k);
      expect(record).toMatchObject({ state: 'done', fingerprint: 'abc:def' });
      if (record?.state !== 'done') throw new Error('not stored');
      expect(record.response.status).toBe(201);
      expect(record.response.headers).toEqual(response.headers);
      expect(new TextDecoder().decode(record.response.body)).toBe(
        '{"order":1}',
      );
      expect(await store.claim(k, claimOf(), 5000)).toBe(false);
    });

    it('frees a key whose lease ran out', async () => {
      const store = make();
      const k = key();
      expect(await store.claim(k, claimOf(), 50)).toBe(true);
      expect(await store.claim(k, claimOf(), 50)).toBe(false);
      await Bun.sleep(80);
      expect(await store.read(k)).toBeUndefined();
      expect(await store.claim(k, claimOf(), 5000)).toBe(true);
    });

    it('releases only its own claim', async () => {
      const store = make();
      const k = key();
      const mine = claimOf();
      await store.claim(k, mine, 5000);
      await store.release(k, claimOf());
      expect(await store.read(k)).toBeDefined();
      await store.release(k, mine);
      expect(await store.read(k)).toBeUndefined();
    });

    it('ignores a completion from a request whose lease was taken over', async () => {
      const store = make();
      const k = key();
      const late = claimOf('late');
      await store.claim(k, late, 30);
      await Bun.sleep(60);
      const retry = claimOf('retry');
      expect(await store.claim(k, retry, 5000)).toBe(true);
      await store.complete(k, late, response, 5000);
      expect(await store.read(k)).toEqual({
        state: 'pending',
        fingerprint: 'retry',
      });
    });
  });
};

contract('MemoryIdempotencyStore', () => new MemoryIdempotencyStore());

if (HAS_REDIS) {
  contract(
    'RedisIdempotencyStore against a live Redis',
    () => new RedisIdempotencyStore(redisClient()),
  );
}

describe('MemoryIdempotencyStore bounds', () => {
  // Memory operations settle their state synchronously. Restore the clock before
  // awaiting their result so another test never observes a mocked Date.now.
  const at = <T>(now: number, operation: () => T): T => {
    const realNow = Date.now;
    Date.now = () => now;
    try {
      return operation();
    } finally {
      Date.now = realNow;
    }
  };

  it('evicts the oldest live entry at maxKeys', async () => {
    const store = new MemoryIdempotencyStore(2);
    await store.claim('a', claimOf(), 5000);
    await store.claim('b', claimOf(), 5000);
    await store.claim('c', claimOf(), 5000);
    expect(await store.read('a')).toBeUndefined();
    expect(await store.read('b')).toBeDefined();
    expect(await store.read('c')).toBeDefined();
  });

  it('sweeps expired entries before evicting a live one', async () => {
    const store = new MemoryIdempotencyStore(2);
    await store.claim('a', claimOf(), 5000);
    await store.claim('b', claimOf(), 10);
    await Bun.sleep(20);
    await store.claim('c', claimOf(), 5000);
    expect(await store.read('a')).toBeDefined();
    expect(await store.read('c')).toBeDefined();
  });

  it('reclaims leases at their exact deadlines before evicting live entries', async () => {
    const store = new MemoryIdempotencyStore(3);
    await at(1000, () => store.claim('a', claimOf(), 1000));
    await at(1000, () => store.claim('b', claimOf(), 100));
    await at(1000, () => store.claim('c', claimOf(), 150));

    await at(1100, () => store.claim('d', claimOf(), 1000));
    expect(await at(1100, () => store.read('a'))).toBeDefined();
    expect(await at(1100, () => store.read('b'))).toBeUndefined();
    expect(await at(1100, () => store.read('c'))).toBeDefined();

    await at(1150, () => store.claim('e', claimOf(), 1000));
    expect(await at(1150, () => store.read('a'))).toBeDefined();
    expect(await at(1150, () => store.read('c'))).toBeUndefined();
    expect(await at(1150, () => store.read('d'))).toBeDefined();
    expect(await at(1150, () => store.read('e'))).toBeDefined();
  });

  it('reclaims a completed response whose TTL is shorter than its lease', async () => {
    const store = new MemoryIdempotencyStore(2);
    const claim = claimOf();
    await at(1000, () => store.claim('a', claimOf(), 5000));
    await at(1000, () => store.claim('b', claim, 5000));
    await at(1010, () => store.complete('b', claim, response, 40));

    await at(1050, () => store.claim('c', claimOf(), 5000));
    expect(await at(1050, () => store.read('a'))).toBeDefined();
    expect(await at(1050, () => store.read('b'))).toBeUndefined();
    expect(await at(1050, () => store.read('c'))).toBeDefined();
  });

  it('retains a completed response beyond its original lease deadline', async () => {
    const store = new MemoryIdempotencyStore(3);
    const claim = claimOf();
    await at(1000, () => store.claim('a', claimOf(), 5000));
    await at(1000, () => store.claim('b', claim, 50));
    await at(1000, () => store.claim('c', claimOf(), 5000));
    await at(1010, () => store.complete('b', claim, response, 2000));

    await at(1050, () => store.claim('d', claimOf(), 5000));
    expect(await at(1050, () => store.read('a'))).toBeUndefined();
    expect(await at(1050, () => store.read('b'))).toEqual({
      state: 'done',
      fingerprint: claim.fingerprint,
      response,
    });
    expect(await at(1050, () => store.read('c'))).toBeDefined();
    expect(await at(1050, () => store.read('d'))).toBeDefined();
  });

  it.each(['read', 'release', 'eviction'] as const)(
    'still reclaims expired leases after the earliest entry is removed by %s',
    async (removal) => {
      const store = new MemoryIdempotencyStore(3);
      const claim = claimOf();
      await at(1000, () => store.claim('a', claim, 50));
      await at(1000, () => store.claim('b', claimOf(), 100));
      await at(1000, () => store.claim('c', claimOf(), 1000));

      if (removal === 'read') {
        expect(await at(1050, () => store.read('a'))).toBeUndefined();
        await at(1050, () => store.claim('d', claimOf(), 1000));
      } else {
        if (removal === 'release') {
          await at(1040, () => store.release('a', claim));
        }
        await at(1040, () => store.claim('d', claimOf(), 1000));
      }

      await at(1100, () => store.claim('e', claimOf(), 1000));
      expect(await at(1100, () => store.read('a'))).toBeUndefined();
      expect(await at(1100, () => store.read('b'))).toBeUndefined();
      expect(await at(1100, () => store.read('c'))).toBeDefined();
      expect(await at(1100, () => store.read('d'))).toBeDefined();
      expect(await at(1100, () => store.read('e'))).toBeDefined();
    },
  );

  it('keeps insertion-order eviction through repeated claims, reads and completion', async () => {
    const store = new MemoryIdempotencyStore(3);
    const claim = claimOf();
    await at(1000, () => store.claim('a', claim, 5000));
    await at(1000, () => store.claim('b', claimOf(), 5000));
    await at(1000, () => store.claim('c', claimOf(), 5000));
    await at(1010, () => store.complete('a', claim, response, 5000));
    expect(await at(1010, () => store.read('b'))).toBeDefined();

    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (let index = 3; index < keys.length; index++) {
      await at(1020, () => store.claim(keys[index]!, claimOf(), 5000));
      for (let previous = 0; previous <= index; previous++) {
        const record = await at(1020, () => store.read(keys[previous]!));
        if (previous <= index - 3) expect(record).toBeUndefined();
        else expect(record).toBeDefined();
      }
    }
  });

  it('is a contract that cannot be constructed itself', () => {
    const Abstract = IdempotencyStore as unknown as new () => unknown;
    expect(() => new Abstract()).toThrow(/is a contract/);
  });
});

@Controller('/charges')
class Charges {
  static count = 0;

  @Idempotent()
  @Post('/')
  charge(): { charge: number } {
    Charges.count += 1;
    return { charge: Charges.count };
  }
}

describe('a crashed request', () => {
  /**
   * A process that died mid-handler never completes or releases, so the claim it
   * left is all there is. Past the lease it no longer blocks the key.
   */
  it('blocks its key with 409 only until the lease runs out', async () => {
    const store = new MemoryIdempotencyStore();
    @Module({
      imports: [
        IdempotencyModule.forRoot({
          prefix: 'crash',
          subject: () => undefined,
          store,
          leaseSeconds: 1,
        }),
      ],
      controllers: [Charges],
    })
    class Root {}
    const app = await HttpFactory.create(Root, {
      requestLogging: false,
      bootLogging: false,
    });
    const base = await app.listen(0);
    const send = () =>
      fetch(`${base}charges`, {
        method: 'POST',
        headers: { 'idempotency-key': 'k-crash' },
      });

    // The fingerprint the guard computes for this request, so the left-behind
    // claim reads as the same request in flight rather than a different one.
    const fingerprint = new Bun.CryptoHasher('sha256')
      .update('POST /charges\n')
      .digest('hex');
    await store.claim('crash:idempotency::k-crash', claimOf(fingerprint), 1000);
    expect((await send()).status).toBe(409);
    await Bun.sleep(1050);
    const ran = await send();
    expect(ran.status).toBe(201);
    expect(ran.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    await app.shutdown();
  });
});

describe.skipIf(!HAS_REDIS)('RedisIdempotencyStore through the guard', () => {
  it('replays across two app instances sharing one Redis', async () => {
    const boot = async () => {
      @Module({
        imports: [
          IdempotencyModule.forRoot({
            prefix: `replicas-${process.pid}`,
            subject: () => undefined,
            store: new RedisIdempotencyStore(redisClient()),
          }),
        ],
        controllers: [Charges],
      })
      class Root {}
      const app = await HttpFactory.create(Root, {
        requestLogging: false,
        bootLogging: false,
      });
      return { app, base: await app.listen(0) };
    };
    const one = await boot();
    const two = await boot();
    const key = crypto.randomUUID();
    const send = (base: string) =>
      fetch(`${base}charges`, {
        method: 'POST',
        headers: { 'idempotency-key': key },
      });

    const first = await (await send(one.base)).json();
    const replay = await send(two.base);
    expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await replay.json()).toEqual(first);
    await one.app.shutdown();
    await two.app.shutdown();
  });

  it('answers 503 when Redis cannot be reached', async () => {
    @Module({
      imports: [
        IdempotencyModule.forRoot({
          prefix: 'unreachable',
          subject: () => undefined,
          store: new RedisIdempotencyStore(
            new Bun.RedisClient('redis://127.0.0.1:1', { maxRetries: 0 }),
          ),
        }),
      ],
      controllers: [Charges],
    })
    class Root {}
    const app = await HttpFactory.create(Root, {
      requestLogging: false,
      bootLogging: false,
    });
    const base = await app.listen(0);
    const before = Charges.count;
    const refused = await fetch(`${base}charges`, {
      method: 'POST',
      headers: { 'idempotency-key': 'k-unreachable' },
    });
    expect(refused.status).toBe(503);
    expect(Charges.count).toBe(before);
    await app.shutdown();
  });
});
