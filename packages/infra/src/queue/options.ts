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
   * Forwarded to every `Bun.RedisClient` the queue opens - `connectionTimeout`,
   * `maxRetries`, `autoReconnect` and the rest.
   *
   * **Defaults to `{ connectionTimeout: 5000, maxRetries: 0 }`, and both halves
   * of that were measured rather than guessed.** With Bun's own defaults a client
   * that cannot reach Redis retries without bound, so `publish()` never settles
   * and a route waiting on it hangs instead of answering. And with **any**
   * `maxRetries > 0`, a client that never connected keeps a retry timer alive past
   * `close()` and the process never exits - verified here at `maxRetries: 3`,
   * where a full-example boot with no Redis survived SIGTERM for 12s. See
   * docs/bun-apis.md, "A failed connection leaks a retry timer past `close()`".
   *
   * So `0` is the only default that both fails fast and lets the process die.
   *
   * **The trade:** a worker set to `0` will not ride out a Redis blip. Raise it if
   * that matters more than a clean exit on a cold start against an absent Redis -
   * they cannot both be had until Bun clears the timer on `close()`.
   */
  readonly connection?: Bun.RedisOptions;
  /**
   * The file bullmq forks into for a queue marked `background`.
   *
   * **Absolute.** bullmq resolves it in the child, not against the module that
   * configured it, so a relative specifier resolves from the child's cwd and
   * silently finds nothing:
   *
   * ```ts
   * processor: new URL('./jobs.processor.ts', import.meta.url).pathname,
   * ```
   *
   * Its default export is the processor, and `JobProcessor` builds one from a
   * module in three lines. Only queues with a `background` handler use it.
   */
  readonly processor?: string;
  /**
   * `'process'` forks; `'thread'` uses a worker thread.
   *
   * **Use `'process'` unless the app is prebuilt.** Both carry the child's stdout
   * back to the parent - measured on Bun 1.3.14, and worker threads did not always,
   * so that half is fixed upstream. They differ on something dunx-specific: a fork
   * is a fresh Bun process, so it reads `bunfig.toml` and `@dunx/transform/preload`
   * runs over the `.ts` files it loads. A thread enters through bullmq's prebuilt
   * `main-worker.js`, where the preload cannot match a `.ts` file - so nothing gets
   * a dependency record and the first provider with a constructor parameter fails
   * at boot, naming that parameter.
   *
   * `'thread'` is therefore for an app whose dependencies were recorded at **build**
   * time - `Bun.build({ plugins: [depsPlugin] })`. It also isolates less: a thread
   * shares the address space, so a handler that segfaults takes the whole process.
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
   * `onShutdown`, which runs in reverse construction order and therefore **before**
   * the connections the handlers use. That ordering is the reason this lives here
   * rather than in an entrypoint: nothing an app writes by hand can guarantee it.
   */
  readonly consume?: boolean;
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
  readonly consume: boolean;

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
