import { describe, expect, it } from 'bun:test';
import { redisStorage, type RedisStore } from './redis.js';

interface Call {
  readonly command: string;
  readonly args: readonly unknown[];
}

/** Enough of `Bun.RedisClient`'s semantics to see which command each method issues. */
const fake = (): {
  store: RedisStore;
  calls: Call[];
  values: Map<string, string>;
} => {
  const calls: Call[] = [];
  const values = new Map<string, string>();
  const record = (command: string, ...args: readonly unknown[]): void => {
    calls.push({ command, args });
  };

  return {
    calls,
    values,
    store: {
      get: async (key) => {
        record('get', key);
        return values.get(String(key)) ?? null;
      },
      getdel: async (key) => {
        record('getdel', key);
        const value = values.get(String(key)) ?? null;
        values.delete(String(key));
        return value;
      },
      incr: async (key) => {
        record('incr', key);
        const next = Number(values.get(String(key)) ?? '0') + 1;
        values.set(String(key), String(next));
        return next;
      },
      expire: async (key, seconds) => {
        record('expire', key, seconds);
        return true;
      },
      set: async (key, value, options) => {
        record('set', key, value, options);
        values.set(String(key), String(value));
        return 'OK';
      },
      del: async (key) => {
        record('del', key);
        return values.delete(String(key)) ? 1 : 0;
      },
    },
  };
};

describe('redisStorage', () => {
  it('reads and writes through GET and SET', async () => {
    const { store, calls } = fake();
    const storage = redisStorage(store);

    await storage.set('session:1', 'value');
    expect(await storage.get('session:1')).toBe('value');
    expect(calls.map((call) => call.command)).toEqual(['set', 'get']);
  });

  it('passes a TTL as SET EX, and omits it when there is none', async () => {
    const { store, calls } = fake();
    const storage = redisStorage(store);

    await storage.set('a', 'x', 60);
    await storage.set('b', 'y');
    expect(calls[0]?.args[2]).toEqual({ ex: 60 });
    expect(calls[1]?.args[2]).toEqual({});
  });

  it('consumes a single-use value with GETDEL rather than read-then-delete', async () => {
    const { store, calls } = fake();
    const storage = redisStorage(store);

    await storage.set('token', 'once');
    expect(await storage.getAndDelete?.('token')).toBe('once');
    expect(await storage.get('token')).toBeNull();
    expect(calls.map((call) => call.command)).toEqual(['set', 'getdel', 'get']);
  });

  it('sets the counter TTL on creation only, so the window does not slide', async () => {
    const { store, calls } = fake();
    const storage = redisStorage(store);

    expect(await storage.increment?.('rate:ip', 30)).toBe(1);
    expect(await storage.increment?.('rate:ip', 30)).toBe(2);
    expect(await storage.increment?.('rate:ip', 30)).toBe(3);
    expect(calls.filter((call) => call.command === 'expire')).toHaveLength(1);
  });

  it('deletes without leaking the removed count into better-auth’s contract', async () => {
    const { store } = fake();
    const storage = redisStorage(store);

    await storage.set('gone', 'x');
    expect(await storage.delete('gone')).toBeUndefined();
    expect(await storage.get('gone')).toBeNull();
  });
});
