import { AppError } from '@dunx/core';

/** Frozen object rather than an `enum` - see CLAUDE.md. */
export const QueueErrorCode = Object.freeze({
  /** Two handlers claim the same `(queue, name)` pair. A boot error. */
  DUPLICATE_HANDLER: 'ERR_QUEUE_DUPLICATE_HANDLER',
  /** A worker process found nothing to consume, so it would idle forever. */
  NO_HANDLERS: 'ERR_QUEUE_NO_HANDLERS',
  /** A job arrived that no handler claims. bullmq retries, then fails it. */
  UNKNOWN_JOB: 'ERR_QUEUE_UNKNOWN_JOB',
  /** A handler outran `jobTimeoutMs`. */
  TIMED_OUT: 'ERR_QUEUE_TIMED_OUT',
  INVALID_STATE: 'ERR_QUEUE_INVALID_STATE',
  INVALID_URL: 'ERR_QUEUE_INVALID_URL',
} as const);

export type QueueErrorCode =
  (typeof QueueErrorCode)[keyof typeof QueueErrorCode];

export class QueueError extends AppError {
  override name = 'QueueError';

  constructor(
    readonly code: QueueErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
