import { AppError } from '@dunx/core';

/** Frozen object rather than an `enum` - see CLAUDE.md. */
export const AmqpErrorCode = Object.freeze({
  /** Two handlers claim the same queue. A boot error. */
  DUPLICATE_HANDLER: 'ERR_AMQP_DUPLICATE_HANDLER',
  /** A consuming process found nothing to consume, so it would idle forever. */
  NO_HANDLERS: 'ERR_AMQP_NO_HANDLERS',
  /** A handler outran `handlerTimeoutMs`. */
  TIMED_OUT: 'ERR_AMQP_TIMED_OUT',
  /** A publish outran `publishTimeoutMs`, so the broker never confirmed it. */
  PUBLISH_TIMED_OUT: 'ERR_AMQP_PUBLISH_TIMED_OUT',
  INVALID_STATE: 'ERR_AMQP_INVALID_STATE',
  INVALID_URL: 'ERR_AMQP_INVALID_URL',
} as const);

export type AmqpErrorCode = (typeof AmqpErrorCode)[keyof typeof AmqpErrorCode];

export class AmqpError extends AppError {
  override name = 'AmqpError';

  constructor(
    readonly code: AmqpErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
