import { AppError } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { ImageError, ImageErrorCode, toImageError } from './errors.js';

const withCode = (code: string, extra: object = {}): Error =>
  Object.assign(new Error(`boom ${code}`), { code, ...extra });

describe('ImageError', () => {
  it('is an AppError, so one catch clause covers the framework', () => {
    const error = new ImageError(ImageErrorCode.DECODE_FAILED, 'nope');
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ImageError');
    expect(error.code).toBe('ERR_IMAGE_DECODE_FAILED');
  });

  it('leaves cause unset when none was given', () => {
    expect(
      new ImageError(ImageErrorCode.DECODE_FAILED, 'nope').cause,
    ).toBeUndefined();
  });
});

describe('toImageError', () => {
  it('passes an ImageError straight through', () => {
    const original = new ImageError(ImageErrorCode.UNKNOWN_FORMAT, 'first');
    expect(toImageError(original, 'context')).toBe(original);
  });

  it("keeps Bun's own codes verbatim", () => {
    for (const code of [
      ImageErrorCode.UNKNOWN_FORMAT,
      ImageErrorCode.DECODE_FAILED,
      ImageErrorCode.ENCODE_FAILED,
      ImageErrorCode.FORMAT_UNSUPPORTED,
      ImageErrorCode.TOO_MANY_PIXELS,
      ImageErrorCode.INVALID_STATE,
      ImageErrorCode.INVALID_ARGUMENT,
    ]) {
      const mapped = toImageError(withCode(code), 'while decoding');
      expect(mapped.code, code).toBe(code);
      expect(mapped.message, code).toBe(`while decoding: boom ${code}`);
    }
  });

  it('collapses a syscall failure to UNREADABLE_SOURCE and keeps the code', () => {
    const mapped = toImageError(
      withCode('EACCES', { syscall: 'open', path: '/root/secret.png' }),
      'could not read image',
    );
    expect(mapped.code).toBe('ERR_IMAGE_UNREADABLE_SOURCE');
    expect(mapped.message).toContain('(EACCES)');
  });

  it('falls back to DECODE_FAILED for an unrecognised throw', () => {
    expect(toImageError(new Error('mystery'), 'ctx').code).toBe(
      'ERR_IMAGE_DECODE_FAILED',
    );
    expect(toImageError('a string', 'ctx').message).toBe('ctx: a string');
    expect(toImageError(null, 'ctx').code).toBe('ERR_IMAGE_DECODE_FAILED');
    expect(toImageError({ code: 42 }, 'ctx').code).toBe(
      'ERR_IMAGE_DECODE_FAILED',
    );
  });

  it('records the original throw as the cause', () => {
    const cause = withCode('ERR_IMAGE_DECODE_FAILED');
    expect(toImageError(cause, 'ctx').cause).toBe(cause);
  });
});
