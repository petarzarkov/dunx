import { AppError } from '@dunx/core';

/**
 * The `code` values `Bun.RedisClient` puts on the errors it throws, plus one of
 * ours for URL validation. Frozen object rather than an `enum` - see CLAUDE.md.
 *
 * `INVALID_RESPONSE` is the surprising one: Bun uses it for errors the *server*
 * returned, so `WRONGTYPE` and `ERR unknown command` both arrive under it. The
 * response was well-formed; the command was not.
 */
export const RedisErrorCode = Object.freeze({
  CONNECTION_CLOSED: 'ERR_REDIS_CONNECTION_CLOSED',
  INVALID_RESPONSE: 'ERR_REDIS_INVALID_RESPONSE',
  INVALID_STATE: 'ERR_REDIS_INVALID_STATE',
  INVALID_ARG_TYPE: 'ERR_INVALID_ARG_TYPE',
  INVALID_URL: 'ERR_REDIS_INVALID_URL',
  UNKNOWN: 'ERR_REDIS_UNKNOWN',
} as const);

export type RedisErrorCode =
  (typeof RedisErrorCode)[keyof typeof RedisErrorCode];

export class RedisError extends AppError {
  override name = 'RedisError';

  constructor(
    readonly code: string,
    message: string,
    /** The command that failed, uppercased - absent for connection setup. */
    readonly command?: string,
    cause?: unknown,
  ) {
    super(command ? `${command}: ${message}` : message, { cause });
  }
}

const codeOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    if (typeof code === 'string') return code;
  }
  return RedisErrorCode.UNKNOWN;
};

/**
 * Normalises whatever came out of `Bun.RedisClient` into a `RedisError`.
 *
 * Bun raises some of these *synchronously* - calling a data command while the
 * connection is in subscriber mode throws rather than rejecting - so callers wrap
 * the invocation, not just the await, and an `async` wrapper turns both shapes
 * into a rejection.
 */
export const toRedisError = (command: string, cause: unknown): RedisError => {
  if (cause instanceof RedisError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new RedisError(codeOf(cause), message, command, cause);
};

/** True when the failure means "no usable connection", not "bad command". */
export const isConnectionError = (error: unknown): boolean =>
  error instanceof RedisError &&
  error.code === RedisErrorCode.CONNECTION_CLOSED;
