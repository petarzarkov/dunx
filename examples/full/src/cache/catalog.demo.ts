import { Logger } from '@dunx/core';
import { CacheOptions, TieredCacheStore } from '@dunx/infra/cache';

/**
 * One read, a second that never reaches the loader, ten at once that share a
 * single load, and an eviction that makes the next one load again.
 */
export class CatalogDemo {
  constructor(
    private readonly logger: Logger,
    private readonly options: CacheOptions,
  ) {}

  async demonstrate(url: string): Promise<void> {
    const tiers =
      this.options.store instanceof TieredCacheStore
        ? 'L1 memory in front of L2 redis'
        : 'L1 memory only, redis unreachable at boot';
    this.logger.info(`store -> ${tiers}, default ttl ${this.options.ttl}ms`);

    const before = await this.loads(url);
    const first = await this.quote(url, 'dunx');
    const second = await this.quote(url, 'dunx');
    this.logger.info(
      `GET /api/catalog/dunx twice -> ${first}, ${second} ` +
        `(loads ${before} -> ${await this.loads(url)})`,
    );

    const at = await this.loads(url);
    await Promise.all(Array.from({ length: 10 }, () => this.quote(url, 'bun')));
    this.logger.info(
      `10 concurrent reads of an uncached key -> ${(await this.loads(url)) - at} ` +
        'load (single flight, per process)',
    );

    const evicted = await fetch(new URL('api/catalog/dunx', url), {
      method: 'DELETE',
    });
    const after = await this.loads(url);
    await this.quote(url, 'dunx');
    this.logger.info(
      `DELETE -> ${JSON.stringify(await evicted.json())}, the next read ` +
        `loads again (loads ${after} -> ${await this.loads(url)})`,
    );
  }

  private async quote(url: string, symbol: string): Promise<number> {
    const response = await fetch(new URL(`api/catalog/${symbol}`, url));
    return ((await response.json()) as { price: number }).price;
  }

  private async loads(url: string): Promise<number> {
    const response = await fetch(new URL('api/catalog', url));
    return ((await response.json()) as { loads: number }).loads;
  }
}
