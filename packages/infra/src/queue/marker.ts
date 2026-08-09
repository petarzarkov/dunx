// Symbol.for, so two copies of @dunx/infra in a tree still agree on the key. The
// marker goes on the method function itself - nothing accumulates at class
// definition time, so there is no ordering dependence and no cross-file leak.
// Same technique as route and gateway discovery; see docs/ARCHITECTURE.md,
// "Route discovery".
const JOB = Symbol.for('dunx.job.handler');

export interface JobMeta {
  /** The bullmq queue the handler consumes from. */
  readonly queue: string;
  /** The job name within that queue - what `publish` addresses. */
  readonly name: string;
  /**
   * Run this queue's jobs in a **child process** rather than on the consuming
   * process's event loop.
   *
   * Per queue rather than per handler: bullmq opens one `Worker` per queue and a
   * worker is either sandboxed or not, so marking any handler on a queue marks
   * the queue. The boot log says which each queue got.
   *
   * What it buys is isolation and traceability at once. A handler that blocks,
   * leaks or crashes takes its child down and leaves the server answering, and
   * the child's stdout is still the parent's - so its log lines land in the same
   * stream, with `job.log()` putting them on the job for bull-board as well.
   *
   * What it costs is a container per child and an IPC hop per job, which is why a
   * short handler is better left in the foreground.
   *
   * Needs `QueueModule.forRoot({ processor })` - the file bullmq forks into. A
   * queue marked `background` with no processor configured is a boot error rather
   * than a silent demotion to the foreground.
   */
  readonly background?: boolean;
}

interface JobMarked {
  readonly [JOB]?: JobMeta;
}

export const markJobHandler = (target: object, meta: JobMeta): void => {
  Object.defineProperty(target, JOB, { value: meta, configurable: true });
};

export const jobMetaOf = (value: unknown): JobMeta | undefined =>
  typeof value === 'function' ? (value as JobMarked)[JOB] : undefined;
