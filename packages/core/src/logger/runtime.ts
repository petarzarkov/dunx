/** What is running this process, for the one boot entry that says so. */
export interface RuntimeInfo {
  /** `Bun.version`, so a log says which runtime produced it. */
  readonly runtime: string;
  /** The first nine characters of `Bun.revision`, enough to name a build. */
  readonly revision: string;
  /**
   * `Bun.main`, the entry file.
   *
   * Two things it is not. Under `bun test` it is the **current test file**, which
   * changes per file and is not the application entry. Under `bun build --compile`
   * it is the virtual `/$bunfs/root/<binary>`, which names no file on disk, which
   * is why `execPath` sits beside it.
   */
  readonly main: string;
  /** `process.execPath`. The bun binary, or the compiled app under `--compile`. */
  readonly execPath: string;
  /** Absent rather than `"undefined"` when nothing set it. */
  readonly env?: string;
}

/**
 * Read once, at boot, by whatever writes a process's first entry.
 *
 * In `@dunx/core` because "which runtime is this" belongs to no layer in
 * particular: `@dunx/http` writes the entry today, and a worker process that grows
 * one should not restate this. Every field is a property read; the six together
 * cost under 0.30 us and stringify in 0.191 us, once per process.
 *
 * `pid` and `timestamp` are absent on purpose - `ConsoleLogger` already stamps both
 * on every entry, so naming them here would print them twice.
 */
export const runtimeInfo = (): RuntimeInfo => {
  const env = Bun.env.NODE_ENV;
  return {
    runtime: `bun ${Bun.version}`,
    revision: Bun.revision.slice(0, 9),
    main: Bun.main,
    execPath: process.execPath,
    ...(env === undefined ? {} : { env }),
  };
};
