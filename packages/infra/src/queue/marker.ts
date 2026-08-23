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
   * Run this queue's jobs in a child process rather than on the consuming
   * process's event loop. Per queue, since bullmq opens one `Worker` per queue:
   * marking any handler marks the queue, and the boot log says which got what.
   *
   * A handler that blocks or crashes takes its child down and leaves the server
   * answering, and the child's stdout is still the parent's. It costs a container
   * per child and an IPC hop per job.
   *
   * Needs `QueueModule.forRoot({ processor })`; without one it is a boot error.
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
