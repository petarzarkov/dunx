import { AppError } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { MemoryCacheStore } from './memory.js';
import { CacheStore } from './store.js';

describe('CacheStore', () => {
  it('refuses to be constructed directly', () => {
    // The container works on runtime values, where `abstract` stops nothing:
    // `get(CacheStore)` with nothing bound would otherwise hand back an instance
    // whose every method is undefined.
    const build = (): CacheStore =>
      new (CacheStore as unknown as new () => CacheStore)();
    expect(build).toThrow(AppError);
    expect(build).toThrow(/CacheModule.forRoot/);
  });

  it('is satisfied by a subclass calling super()', () => {
    expect(new MemoryCacheStore()).toBeInstanceOf(CacheStore);
  });
});
