import type { CacheRedis } from './redis.js';

/** A `CacheRedis` with no server, so the L2 paths are asserted without one. */
export class FakeRedis implements CacheRedis {
  readonly entries = new Map<string, { value: string; expiresAt: number }>();
  readonly writes: { key: string; px: number | undefined }[] = [];

  get(key: string): Promise<string | null> {
    const held = this.entries.get(key);
    if (held === undefined) return Promise.resolve(null);
    if (held.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(held.value);
  }

  set(
    key: string,
    value: string,
    options?: { readonly px?: number },
  ): Promise<string | null> {
    this.writes.push({ key, px: options?.px });
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + (options?.px ?? 60_000),
    });
    return Promise.resolve('OK');
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.entries.delete(key) ? 1 : 0);
  }
}
