import {
  NoopTracer,
  type Logger,
  type OnShutdown,
  type Tracer,
} from '@dunx/core';
import { closeWithin, within } from '../close-within.js';
import type { DbConnection, DbOptions } from './connection.js';
import { DatabaseError } from './errors.js';
import { instrumented } from './instrument.js';
import type { QueryMetrics } from './metrics.js';

export interface DataSourcesInit<TDb> {
  /**
   * The options a data source opens with, from its key. A rejection is not
   * cached, so the next call retries.
   */
  readonly create: (key: string) => DbOptions<TDb> | Promise<DbOptions<TDb>>;
  /**
   * Live data sources held at once. Reaching it evicts the least recently used
   * one that nothing is borrowing. `0` removes the bound, and an unbounded key
   * space then exhausts the database's own connection limit.
   */
  readonly max?: number;
  /** Close a data source this long after its last use. `0` keeps every one. */
  readonly idleMs?: number;
  /**
   * How often the idle sweep runs, so a data source lives at most `idleMs` plus
   * this after its last use. Defaults to `idleMs`.
   */
  readonly sweepMs?: number;
  /** Bounds both the wait on an open and the close itself. */
  readonly closeTimeoutMs?: number;
}

interface Entry<TDb> {
  readonly opening: Promise<DbConnection<TDb>>;
  lastUsed: number;
  /** Outstanding {@link DataSources.use} calls. Eviction skips a borrowed one. */
  leases: number;
}

/**
 * Recency is the map's insertion order, refreshed by re-setting the key.
 * `Date.now()` has millisecond resolution, so two data sources touched in one
 * tick compare equal and the wrong one goes.
 */
const touch = <TDb>(
  entries: Map<string, Entry<TDb>>,
  key: string,
  entry: Entry<TDb>,
): Entry<TDb> => {
  entry.lastUsed = Date.now();
  if (entries.delete(key)) entries.set(key, entry);
  return entry;
};

const DEFAULT_MAX = 32;
const DEFAULT_IDLE_MS = 300_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Data sources keyed at runtime - a database per tenant - each opened on first
 * use and reused after it. Subclass it and hand the subclass to
 * `DbModule.forDataSources` to keep the drizzle handle type.
 *
 * Resolution takes the key as an argument and holds no current data source, so
 * two requests for two tenants cannot read each other's database.
 */
export class DataSources<TDb = unknown> implements OnShutdown {
  readonly #entries = new Map<string, Entry<TDb>>();
  readonly #create: DataSourcesInit<TDb>['create'];
  readonly #max: number;
  readonly #idleMs: number;
  readonly #sweepMs: number;
  readonly #closeTimeoutMs: number;
  readonly #logger: Logger | undefined;
  readonly #metrics: QueryMetrics | undefined;
  /** Absent for the no-op, so an untraced pool opens its drivers unwrapped. */
  readonly #tracer: Tracer | undefined;
  /** Closes started by eviction, which `close()` still has to wait for. */
  readonly #closing = new Set<Promise<void>>();
  #sweep: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(
    init: DataSourcesInit<TDb>,
    logger?: Logger,
    metrics?: QueryMetrics,
    tracer?: Tracer,
  ) {
    this.#create = init.create;
    this.#max = init.max ?? DEFAULT_MAX;
    this.#idleMs = init.idleMs ?? DEFAULT_IDLE_MS;
    this.#sweepMs = init.sweepMs ?? this.#idleMs;
    this.#closeTimeoutMs = init.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#logger = logger;
    this.#metrics = metrics;
    this.#tracer = tracer instanceof NoopTracer ? undefined : tracer;
  }

  /** Live data sources, opening ones included. */
  get size(): number {
    return this.#entries.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  keys(): readonly string[] {
    return [...this.#entries.keys()];
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** The connection behind `key`, for a ping or the raw driver. */
  async connection(key: string): Promise<DbConnection<TDb>> {
    const entry = this.#entry(key);
    const connection = await entry.opening;
    touch(this.#entries, key, entry);
    return connection;
  }

  /** The drizzle handle behind `key`, opened on first use. */
  async get(key: string): Promise<TDb> {
    return (await this.connection(key)).db;
  }

  /** `get`, holding the data source open for `work`: eviction skips a borrowed one. */
  async use<T>(key: string, work: (db: TDb) => T | Promise<T>): Promise<T> {
    const entry = this.#entry(key);
    entry.leases += 1;
    try {
      return await work((await entry.opening).db);
    } finally {
      entry.leases -= 1;
      touch(this.#entries, key, entry);
    }
  }

  /**
   * Closes `key` and forgets it, borrowed or not - a deprovisioned tenant is gone
   * regardless. Resolves `false` if it was not live.
   */
  async evict(key: string): Promise<boolean> {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#entries.delete(key);
    await this.#shut(key, entry);
    return true;
  }

  /** Evicts every unborrowed data source idle longer than `idleMs`. */
  async prune(): Promise<number> {
    if (this.#idleMs <= 0) return 0;
    const cutoff = Date.now() - this.#idleMs;
    let closed = 0;
    // A snapshot, since `evict` below mutates the map this is walking.
    const live = [...this.#entries];
    for (const [key, entry] of live) {
      if (entry.leases > 0 || entry.lastUsed > cutoff) continue;
      if (await this.evict(key)) closed += 1;
    }
    return closed;
  }

  /** Idempotent, and final: a `get` afterwards throws rather than reopening. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#sweep !== undefined) {
      clearInterval(this.#sweep);
      this.#sweep = undefined;
    }
    const live = [...this.#entries];
    this.#entries.clear();
    await Promise.all([
      ...live.map(([key, entry]) => this.#shut(key, entry)),
      ...this.#closing,
    ]);
  }

  async onShutdown(): Promise<void> {
    await this.close();
  }

  /** Synchronous end to end, so admission cannot interleave with a second one. */
  #entry(key: string): Entry<TDb> {
    if (this.#closed) {
      throw new DatabaseError(
        `These data sources are closed, so "${key}" cannot be opened.`,
      );
    }
    const live = this.#entries.get(key);
    if (live !== undefined) return touch(this.#entries, key, live);

    this.#makeRoom(key);

    const entry: Entry<TDb> = {
      opening: this.#open(key),
      lastUsed: Date.now(),
      leases: 0,
    };
    this.#entries.set(key, entry);
    // After the `set`, so a `create` that throws synchronously still drops its
    // entry rather than caching the failure forever.
    void entry.opening.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    this.#startSweep();
    return entry;
  }

  async #open(key: string): Promise<DbConnection<TDb>> {
    const options = await this.#create(key);
    const opened =
      this.#metrics === undefined && this.#tracer === undefined
        ? await options.open()
        : await instrumented(options.open(), this.#metrics, this.#tracer);

    if (this.#closed) {
      await opened.close();
      throw new DatabaseError(
        `These data sources closed while "${key}" was opening.`,
      );
    }
    this.#logger?.debug(`opened data source "${key}"`);
    return opened;
  }

  #makeRoom(key: string): void {
    if (this.#max <= 0) return;
    while (this.#entries.size >= this.#max) {
      const victim = this.#idlest();
      if (victim === undefined) {
        throw new DatabaseError(
          `All ${this.#max} data sources are open and borrowed, so "${key}" ` +
            'has nowhere to go. Raise `max`, or hold fewer at once.',
        );
      }
      this.#logger?.debug(`evicting data source "${victim}" to make room`);
      this.#drop(victim);
    }
  }

  /**
   * Frees the slot now, closing in the background, tracked so `close()` waits.
   * Waiting here would put a yield back into admission.
   */
  #drop(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    const closing = this.#shut(key, entry).finally(() => {
      this.#closing.delete(closing);
    });
    this.#closing.add(closing);
  }

  /** The first unborrowed key, which is the least recently used one. */
  #idlest(): string | undefined {
    for (const [key, entry] of this.#entries) {
      if (entry.leases === 0) return key;
    }
    return undefined;
  }

  #startSweep(): void {
    if (this.#idleMs <= 0 || this.#sweepMs <= 0 || this.#sweep !== undefined) {
      return;
    }
    this.#sweep = setInterval(() => void this.prune(), this.#sweepMs);
    // An idle bound is no reason to keep the process alive.
    this.#sweep.unref?.();
  }

  async #shut(key: string, entry: Entry<TDb>): Promise<void> {
    // Bounded like the close: a connect with no timeout of its own would
    // otherwise block evict, prune and shutdown indefinitely.
    const settled = entry.opening.then(
      (connection) => ({ connection }),
      () => ({ connection: undefined }),
    );
    const opened = await within(settled, this.#closeTimeoutMs);
    if (opened === undefined) {
      // Still opening, so close it when it surfaces rather than orphan it.
      void settled.then(({ connection }) => connection?.close());
      return;
    }
    const { connection } = opened;
    // The open failed, so there is nothing to close.
    if (connection === undefined) return;
    try {
      if (await closeWithin(connection, this.#closeTimeoutMs)) {
        this.#logger?.warn(
          `data source "${key}" did not close within ${this.#closeTimeoutMs}ms`,
        );
      }
    } catch (error) {
      this.#logger?.warn(`closing data source "${key}" failed`, error);
    }
  }
}
