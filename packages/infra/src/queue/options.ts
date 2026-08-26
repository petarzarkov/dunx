import type { JobsOptions, WorkerOptions as BullWorkerOptions } from 'bullmq';
import { assertRedisUrl, defaultRedisUrl } from '../redis/options.js';
import { QueueError, QueueErrorCode } from './errors.js';

/**
 * The URL check is `/redis`'s, so there is one implementation of it and one
 * message. The **error** is this subpath's, because each subpath is its own bundle:
 * a `RedisError` thrown from here is a different class object than the one
 * `@dunx/infra/redis` exports, so a consumer's `instanceof RedisError` would be
 * false. `code` and message are preserved either way.
 */
const assertUrl = (url: string): string => {
  try {
    return assertRedisUrl(url);
  } catch (cause) {
    throw new QueueError(
      QueueErrorCode.INVALID_URL,
      cause instanceof Error ? cause.message : String(cause),
      cause,
    );
  }
};

/** What dunx sets on every bullmq `Worker` itself, so it is not yours to pass. */
export type WorkerPassthrough = Omit<
  BullWorkerOptions,
  'connection' | 'prefix'
>;

export interface QueueOptionsInit {
  /** Defaults to `$VALKEY_URL`, `$REDIS_URL`, then `valkey://localhost:6379`. */
  readonly url?: string;
  /** bullmq's key prefix. @default 'bull' */
  readonly prefix?: string;
  /**
   * Forwarded verbatim to every `Worker` - `concurrency`, `limiter`,
   * `lockDuration`, `stalledInterval` and the rest. Deliberately a passthrough:
   * restating bullmq's knobs here would be a second, staler copy of its docs.
   */
  readonly worker?: WorkerPassthrough;
  /** Forwarded verbatim as every `Queue`'s `defaultJobOptions`. */
  readonly defaultJobOptions?: JobsOptions;
  /**
   * Forwarded to every `Bun.RedisClient` the queue opens. Defaults to
   * `{ connectionTimeout: 5000, maxRetries: 0 }`: Bun's own defaults retry without
   * bound, so `publish()` never settles, and any `maxRetries > 0` leaves a retry
   * timer alive past `close()` so the process never exits. See docs/bun-apis.md.
   *
   * The trade is that `0` will not ride out a Redis blip. Raise it if that matters
   * more than a clean exit against an absent Redis.
   */
  readonly connection?: Bun.RedisOptions;
  /**
   * The file bullmq forks into for a queue marked `background`. Absolute: bullmq
   * resolves it in the child, so a relative specifier finds nothing.
   *
   * ```ts
   * processor: new URL('./jobs.processor.ts', import.meta.url).pathname,
   * ```
   */
  readonly processor?: string;
  /**
   * `'process'` forks; `'thread'` uses a worker thread. Use `'process'` unless the
   * app is prebuilt: a fork reads `bunfig.toml`, so `@dunx/transform/preload` runs
   * over the `.ts` files it loads, while a thread enters through bullmq's prebuilt
   * `main-worker.js` where the preload cannot match one - so no provider gets a
   * dependency record and the first constructor parameter fails at boot.
   *
   * A thread also shares the address space, so a segfault takes the process.
   *
   * @default 'process'
   */
  readonly isolation?: 'process' | 'thread';
  /**
   * Open workers in **this** process, rather than only binding the publish side.
   *
   * Off by default, and that is the safe way round: `QueueModule` is imported by
   * anything that publishes, and a web process that started consuming because it
   * wanted to enqueue would be a surprise with a database attached.
   *
   * On, the container owns the workers - started at `onInit`, stopped at
   * `onShutdown`, which runs before the connections the handlers use. Nothing an
   * app writes by hand can guarantee that ordering.
   *
   * `'if-any'` stands down with a warning where `true` fails boot, for a
   * migration whose queue wiring lands before its first `@JobHandler`.
   */
  readonly consume?: boolean | 'if-any';
  /**
   * Reject a handler that runs longer than this, so a job hung on an external
   * call fails and retries instead of holding its lock until the stall check
   * reclaims it.
   *
   * Not a bullmq feature - bullmq has `lockDuration` and stall detection, which
   * answer "did the worker die", not "is this handler stuck". Off by default.
   */
  readonly jobTimeoutMs?: number;
}

/**
 * A class, not an interface, so it is a runtime value and can therefore be a
 * constructor parameter type that `@dunx/transform` can record.
 */
export class QueueOptions {
  readonly url: string;
  readonly prefix: string;
  readonly worker: WorkerPassthrough;
  readonly connection: Bun.RedisOptions;
  readonly defaultJobOptions: JobsOptions | undefined;
  readonly jobTimeoutMs: number | undefined;
  readonly processor: string | undefined;
  readonly isolation: 'process' | 'thread';
  readonly consume: boolean | 'if-any';

  constructor(init: QueueOptionsInit = {}) {
    this.url = assertUrl(init.url ?? defaultRedisUrl());
    this.prefix = init.prefix ?? 'bull';
    this.worker = init.worker ?? {};
    // Bounded on purpose - see `connection` above. Unbounded retries turn an
    // absent Redis into a hung request and a process that will not exit.
    this.connection = {
      connectionTimeout: 5000,
      maxRetries: 0,
      ...init.connection,
    };
    this.defaultJobOptions = init.defaultJobOptions;
    this.jobTimeoutMs = init.jobTimeoutMs;
    this.processor = init.processor;
    this.isolation = init.isolation ?? 'process';
    this.consume = init.consume ?? false;
  }

  /** The URL with any password removed, for logs and error messages. */
  get redactedUrl(): string {
    const parsed = new URL(this.url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  }
}
