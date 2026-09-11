import { describe, expect, it } from 'bun:test';
import { MemoryCacheStore } from './memory.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('MemoryCacheStore', () => {
  it('reads back what it wrote', async () => {
    const store = new MemoryCacheStore();
    await store.set('a', { n: 1 }, 1_000);
    expect(await store.get<{ n: number }>('a')).toEqual({ n: 1 });
    expect(store.size).toBe(1);
  });

  it('misses an unknown key', async () => {
    expect(await new MemoryCacheStore().get('nothing')).toBeUndefined();
  });

  it('drops an expired entry on read', async () => {
    const store = new MemoryCacheStore();
    await store.set('a', 1, 5);
    await sleep(15);
    expect(await store.get('a')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('reports whether del removed a live entry', async () => {
    const store = new MemoryCacheStore();
    await store.set('a', 1, 1_000);
    expect(await store.del('a')).toBe(true);
    expect(await store.del('a')).toBe(false);
  });

  it('evicts the least recently used key past max', async () => {
    const store = new MemoryCacheStore({ max: 2 });
    await store.set('a', 1, 1_000);
    await store.set('b', 2, 1_000);
    // Reads `a`, so `b` becomes the coldest.
    expect(await store.get<number>('a')).toBe(1);
    await store.set('c', 3, 1_000);

    expect(store.size).toBe(2);
    expect(await store.get('b')).toBeUndefined();
    expect(await store.get<number>('a')).toBe(1);
    expect(await store.get<number>('c')).toBe(3);
  });

  it('overwrites in place rather than growing', async () => {
    const store = new MemoryCacheStore({ max: 2 });
    await store.set('a', 1, 1_000);
    await store.set('a', 2, 1_000);
    expect(store.size).toBe(1);
    expect(await store.get<number>('a')).toBe(2);
  });

  it('holds at least one entry whatever max is given', async () => {
    const store = new MemoryCacheStore({ max: 0 });
    await store.set('a', 1, 1_000);
    expect(await store.get<number>('a')).toBe(1);
  });

  it('stores a value by reference', async () => {
    const store = new MemoryCacheStore();
    const value = { hits: 0 };
    await store.set('a', value, 1_000);
    const read = await store.get<{ hits: number }>('a');
    expect(read).toBe(value);
  });
});
