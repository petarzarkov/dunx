import { AppError } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import {
  isConnectionError,
  isServerError,
  RedisError,
  RedisErrorCode,
  toRedisError,
} from './errors.js';

const bunError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { name: 'RedisError', code });

describe('RedisError', () => {
  it('is an AppError, so one catch clause covers the framework', () => {
    const error = new RedisError(RedisErrorCode.UNKNOWN, 'boom');
    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe('RedisError');
  });

  it('prefixes the message with the command when there is one', () => {
    expect(new RedisError('E', 'boom', 'GET').message).toBe('GET: boom');
    expect(new RedisError('E', 'boom').message).toBe('boom');
  });
});

describe('toRedisError', () => {
  it('carries over the code Bun set', () => {
    const mapped = toRedisError(
      'GET',
      bunError(RedisErrorCode.CONNECTION_CLOSED, 'Connection closed'),
    );
    expect(mapped.code).toBe(RedisErrorCode.CONNECTION_CLOSED);
    expect(mapped.command).toBe('GET');
    expect(mapped.message).toBe('GET: Connection closed');
  });

  it('keeps the original as cause', () => {
    const cause = bunError(RedisErrorCode.INVALID_STATE, 'subscriber mode');
    expect(toRedisError('SET', cause).cause).toBe(cause);
  });

  it('falls back to UNKNOWN when there is no code', () => {
    expect(toRedisError('PING', new Error('nope')).code).toBe(
      RedisErrorCode.UNKNOWN,
    );
  });

  it('ignores a non-string code', () => {
    const weird = Object.assign(new Error('nope'), { code: 42 });
    expect(toRedisError('PING', weird).code).toBe(RedisErrorCode.UNKNOWN);
  });

  it('stringifies a thrown non-Error', () => {
    expect(toRedisError('PING', 'plain string').message).toBe(
      'PING: plain string',
    );
  });

  it('does not re-wrap something already mapped', () => {
    const already = new RedisError('E', 'boom', 'GET');
    expect(toRedisError('SET', already)).toBe(already);
  });

  /**
   * Bun 1.3 reported a server-side error as INVALID_RESPONSE, which was
   * surprising: the response parsed fine, the command was wrong. 1.4 renamed it
   * to SERVER_ERROR. The code passes through either way, so both are pinned.
   */
  it.each([RedisErrorCode.SERVER_ERROR, RedisErrorCode.INVALID_RESPONSE])(
    'passes a server error code through: %s',
    (code) => {
      const mapped = toRedisError(
        'GET',
        bunError(
          code,
          'WRONGTYPE Operation against a key holding the wrong kind of value',
        ),
      );
      expect(mapped.code).toBe(code);
      expect(mapped.message).toContain('WRONGTYPE');
      expect(isServerError(mapped)).toBe(true);
    },
  );
});

describe('isServerError', () => {
  it('spans the codes Bun 1.3 and 1.4 use, and nothing else', () => {
    expect(
      isServerError(
        toRedisError('GET', bunError(RedisErrorCode.CONNECTION_CLOSED, 'x')),
      ),
    ).toBe(false);
    expect(
      isServerError(
        toRedisError('GET', bunError(RedisErrorCode.INVALID_STATE, 'x')),
      ),
    ).toBe(false);
    expect(isServerError(new Error('x'))).toBe(false);
    expect(isServerError(undefined)).toBe(false);
  });
});

describe('isConnectionError', () => {
  it('is true only for a closed connection', () => {
    expect(
      isConnectionError(
        toRedisError('GET', bunError(RedisErrorCode.CONNECTION_CLOSED, 'x')),
      ),
    ).toBe(true);
    expect(
      isConnectionError(
        toRedisError('GET', bunError(RedisErrorCode.INVALID_RESPONSE, 'x')),
      ),
    ).toBe(false);
    expect(isConnectionError(new Error('x'))).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});
