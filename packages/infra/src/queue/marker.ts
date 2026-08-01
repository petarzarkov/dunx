// Symbol.for, so two copies of @dunx/infra in a tree still agree on the key. The
// marker goes on the method function itself — nothing accumulates at class
// definition time, so there is no ordering dependence and no cross-file leak.
// Same technique as route and gateway discovery; see docs/ARCHITECTURE.md,
// "Route discovery".
const JOB = Symbol.for('dunx.job.handler');

export interface JobMeta {
  /** The bullmq queue the handler consumes from. */
  readonly queue: string;
  /** The job name within that queue — what `publish` addresses. */
  readonly name: string;
}

interface JobMarked {
  readonly [JOB]?: JobMeta;
}

export const markJobHandler = (target: object, meta: JobMeta): void => {
  Object.defineProperty(target, JOB, { value: meta, configurable: true });
};

export const jobMetaOf = (value: unknown): JobMeta | undefined =>
  typeof value === 'function' ? (value as JobMarked)[JOB] : undefined;
