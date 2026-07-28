import type { Query, RunResult } from './contract.js';

/** What a backend has to supply for `LazyQuery` to cover the rest. */
export interface QuerySource<T> {
  all(): Promise<readonly T[]>;
  run(): Promise<RunResult>;
}

/**
 * Turns two functions into the public `Query`. Nothing runs until a terminal
 * method is called, which is what makes `db.sql\`…\`` cheap to build and lets the
 * same expression mean `all()`, `get()` or `run()` depending on how it is ended.
 */
export class LazyQuery<T> implements Query<T> {
  readonly #source: QuerySource<T>;

  constructor(source: QuerySource<T>) {
    this.#source = source;
  }

  all(): Promise<readonly T[]> {
    return this.#source.all();
  }

  async get(): Promise<T | null> {
    const rows = await this.#source.all();
    return rows[0] ?? null;
  }

  run(): Promise<RunResult> {
    return this.#source.run();
  }

  /**
   * Deliberately thenable, so `await db.sql\`…\`` means `all()`. `Bun.SQL`'s own
   * `SQL.Query<T>` extends `Promise<T>` for the same reason — the accident the
   * rule guards against is the intended behaviour here.
   */
  // oxlint-disable-next-line unicorn/no-thenable
  then<Fulfilled = readonly T[], Rejected = never>(
    onFulfilled?:
      | ((value: readonly T[]) => Fulfilled | PromiseLike<Fulfilled>)
      | null,
    onRejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null,
  ): Promise<Fulfilled | Rejected> {
    return this.all().then(onFulfilled, onRejected);
  }
}
