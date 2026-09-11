import { Cache } from '@dunx/infra/cache';

export interface Quote {
  readonly symbol: string;
  readonly price: number;
  readonly loadedAt: number;
}

/** The read `Cache.wrap` stands in front of. Counted, so a demo can show hits. */
export class Catalog {
  #loads = 0;

  constructor(private readonly cache: Cache) {}

  /** How many times the slow read actually ran. */
  get loads(): number {
    return this.#loads;
  }

  quote(symbol: string): Promise<Quote> {
    return this.cache.wrap(`quote:${symbol}`, () => this.#load(symbol));
  }

  /** Drops the entry from both tiers of this process. */
  evict(symbol: string): Promise<boolean> {
    return this.cache.del(`quote:${symbol}`);
  }

  async #load(symbol: string): Promise<Quote> {
    this.#loads += 1;
    await Bun.sleep(25);
    return {
      symbol,
      price: Math.round(symbol.length * 137.5),
      loadedAt: Date.now(),
    };
  }
}
