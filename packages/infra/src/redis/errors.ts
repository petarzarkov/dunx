import { AppError } from '@dunx/core';

/**
 * The `code` values `Bun.RedisClient` puts on the errors it throws, plus one of
 * ours for URL validation. Frozen object rather than an `enum` - see CLAUDE.md.
 *
 * An error the *server* returned - `WRONGTYPE`, `ERR unknown command`, a wrong
 * argument count - arrives as `SERVER_ERROR` on Bun 1.4 and arrived as
 * `INVALID_RESPONSE` on 1.3. The floor is 1.4.1, so only the first can reach a
 * consumer; the second stays listed because removing an exported constant is a
 * breaking change. `isServerError()` is the check to write instead of either.
 */
export const RedisErrorCode = Object.freeze({
  CONNECTION_CLOSED: 'ERR_REDIS_CONNECTION_CLOSED',
  SERVER_ERROR: 'ERR_REDIS_SERVER_ERROR',
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

/** True when Redis itself rejected the command, on either Bun 1.3 or 1.4. */
export const isServerError = (error: unknown): boolean =>
  error instanceof RedisError &&
  (error.code === RedisErrorCode.SERVER_ERROR ||
    error.code === RedisErrorCode.INVALID_RESPONSE);
