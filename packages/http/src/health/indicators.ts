import { statfs } from 'node:fs/promises';
import {
  HealthIndicator,
  type PingProbe,
  type ProbeResult,
  type QueryProbe,
  type StorageProbe,
} from './contracts.js';

const ms = (started: number): number => Math.round(performance.now() - started);

/** Up on a completed round trip, down with the thrown message, detail the
 * latency. Subclass it with a `name` for anything else answering a `ping()`. */
export abstract class RoundTripIndicator extends HealthIndicator {
  constructor(private readonly probe: QueryProbe) {
    super();
  }

  async check(): Promise<ProbeResult> {
    const started = performance.now();
    await this.probe.ping();
    const roundTripMs = ms(started);
    return { state: 'up', detail: `${roundTripMs} ms`, data: { roundTripMs } };
  }
}

/** Redis is up if it answers `PING`. */
export class RedisIndicator extends RoundTripIndicator {
  readonly name = 'redis';

  constructor(redis: PingProbe) {
    super({
      ping: async (): Promise<void> => {
        await redis.ping();
      },
    });
  }
}

/** The database is up if a round trip completes. */
export class DatabaseIndicator extends RoundTripIndicator {
  readonly name = 'database';
}

/**
 * The AMQP broker, up while the connection is established and unblocked, and
 * satisfied by `AmqpConnection` from `@dunx/infra/amqp`. The first probe on an
 * unopened connection waits `readyTimeoutMs`, whose 5 s default outruns
 * `timeoutMs` at 2 s and so reports `unknown`; the rest never wait.
 */
export class AmqpIndicator extends RoundTripIndicator {
  readonly name = 'amqp';
}

export interface StorageProbeOptionsInit {
  readonly key?: string;
}

export class StorageProbeOptions {
  readonly key: string;

  constructor(init: StorageProbeOptionsInit = {}) {
    this.key = init.key ?? '.dunx-health';
  }
}

/**
 * The configured object store, which is what `DiskIndicator` stops measuring the
 * moment an app moves to `S3Storage`. Whether the key exists is no part of the
 * signal and the answer is discarded: a store that replies is up, one that throws
 * is down with the message expired credentials and a missing bucket arrive as.
 */
export class StorageIndicator extends HealthIndicator {
  readonly name = 'storage';

  constructor(
    private readonly storage: StorageProbe,
    private readonly options: StorageProbeOptions = new StorageProbeOptions(),
  ) {
    super();
  }

  async check(): Promise<ProbeResult> {
    const started = performance.now();
    await this.storage.exists(this.options.key);
    const roundTripMs = ms(started);
    return { state: 'up', detail: `${roundTripMs} ms`, data: { roundTripMs } };
  }
}

export interface MemoryOptionsInit {
  /** Report `down` above this resident set size. */
  readonly maxRssBytes: number;
}

export class MemoryOptions {
  readonly maxRssBytes: number;

  constructor(init: MemoryOptionsInit) {
    this.maxRssBytes = init.maxRssBytes;
  }
}

const MIB = 1024 * 1024;
const mib = (bytes: number): string => `${Math.round(bytes / MIB)} MiB`;

/**
 * Resident set size against a ceiling. `process.memoryUsage()` costs 5.96 us,
 * which is what makes it safe on an endpoint scraped every two seconds;
 * `jsc.heapStats()` is 2.2 ms and up and `v8.getHeapStatistics()` 1 to 7.6 ms.
 *
 * Not critical: shedding traffic from a process near its ceiling does not make it
 * use less memory. A ceiling belongs on liveness, where it restarts.
 */
export class MemoryIndicator extends HealthIndicator {
  readonly name = 'memory';
  override readonly critical = false;

  constructor(private readonly options: MemoryOptions) {
    super();
  }

  check(): ProbeResult {
    const { rss } = process.memoryUsage();
    const detail = `${mib(rss)} of ${mib(this.options.maxRssBytes)}`;
    // The bytes the sentence was rendered from, so a scrape does not have to
    // parse "143 MiB of 2048 MiB" back into the two numbers behind it.
    const data = { rssBytes: rss, maxRssBytes: this.options.maxRssBytes };
    return rss > this.options.maxRssBytes
      ? { state: 'down', detail, data }
      : { state: 'up', detail, data };
  }
}

export interface DiskOptionsInit {
  /** Any path on the filesystem to measure. */
  readonly path: string;
  /** Report `down` above this used fraction. `0.9` is 90 percent. */
  readonly maxUsedFraction: number;
}

export class DiskOptions {
  readonly path: string;
  readonly maxUsedFraction: number;

  constructor(init: DiskOptionsInit) {
    this.path = init.path;
    this.maxUsedFraction = init.maxUsedFraction;
  }
}

/**
 * How full a filesystem is.
 *
 * Bun ships no disk API, so this is `node:fs`. The **async** `statfs` at 167 us,
 * not `statfsSync` at 1.85 us, and the slower one is the right call: a stalled
 * network mount blocks the event loop for as long as it stalls, and a health check
 * is exactly what gets called while a mount is stalling.
 *
 * Not critical, for the same reason as memory: no other pod's disk is any emptier.
 */
export class DiskIndicator extends HealthIndicator {
  readonly name = 'disk';
  override readonly critical = false;

  constructor(private readonly options: DiskOptions) {
    super();
  }

  async check(): Promise<ProbeResult> {
    const stats = await statfs(this.options.path);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (total <= 0) return { state: 'unknown', detail: 'no size reported' };

    const used = (total - free) / total;
    const detail = `${Math.round(used * 100)}% of ${mib(total)} used`;
    const data = { totalBytes: total, freeBytes: free, usedFraction: used };
    return used > this.options.maxUsedFraction
      ? { state: 'down', detail, data }
      : { state: 'up', detail, data };
  }
}
