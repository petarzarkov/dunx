import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  captureConsole,
  testConfig,
  testLogger,
  type Capture,
} from './fixture.test.js';

/**
 * The shapes a call site actually takes, ported from arkv's `cases.test.ts`. Each
 * one pins down where the entry's `message` comes from and whether an `error` is
 * synthesized, which is the part of the logger most easily broken by a refactor.
 */
describe('call shapes', () => {
  let capture: Capture;
  let logger: ReturnType<typeof testLogger>;

  beforeEach(() => {
    logger = testLogger(testConfig);
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
  });

  it('log(string, object) merges the object into the entry', () => {
    logger.log('Test', { some: { nested: 'value' } });

    expect(capture.entry()).toMatchObject({
      message: 'Test',
      some: { nested: 'value' },
    });
  });

  it('log(object) keeps a string `error` property as data', () => {
    logger.error({ error: 'Something went wrong', code: 500 });

    const entry = capture.entry();
    expect(entry).toMatchObject({
      level: 'error',
      message: 'Object logged',
      error: 'Something went wrong',
      code: 500,
    });
    expect(entry).not.toHaveProperty('invalidMessageWarning');
  });

  it('log(emptyObject) is not treated as an invalid call', () => {
    logger.error({});

    const entry = capture.entry();
    expect(entry).toMatchObject({ level: 'error', message: 'Object logged' });
    expect(entry).not.toHaveProperty('invalidMessageWarning');
  });

  it('log(null) records the bad call site instead of throwing', () => {
    // @ts-expect-error - a runtime-only call shape; the point is that it survives
    logger.error(null);

    expect(capture.entry()).toMatchObject({
      level: 'error',
      message: '[null]',
      invalidMessageWarning: 'Logger called with non-string message parameter',
      invalidMessageCallstack: expect.any(String),
      originalMessageType: 'object',
      originalMessage: 'null',
    });
  });

  it('log(number) records the bad call site too', () => {
    // @ts-expect-error - a runtime-only call shape; the point is that it survives
    logger.error(42);

    expect(capture.entry()).toMatchObject({
      message: '[OBJECT]: 42',
      originalMessageType: 'number',
      originalMessage: '42',
    });
  });

  it('Case 1: log(string)', () => {
    logger.log('Simple string message');

    const entry = capture.entry();
    expect(entry).toMatchObject({
      level: 'log',
      message: 'Simple string message',
    });
    expect(entry).not.toHaveProperty('error');
  });

  it('Case 2: log(object)', () => {
    logger.log({ userId: '123', action: 'login', success: true });

    const entry = capture.entry();
    expect(entry).toMatchObject({
      level: 'log',
      message: 'Object logged',
      userId: '123',
      action: 'login',
      success: true,
    });
    expect(entry).not.toHaveProperty('error');
  });

  it('Case 3: log(error)', () => {
    logger.error(new Error('Test error'));

    expect(capture.entry()).toMatchObject({
      level: 'error',
      message: 'Test error',
      error: { message: 'Test error', stack: expect.any(String) },
    });
  });

  it('Case 4: log(object with a nested Error)', () => {
    logger.error({
      operation: 'database-query',
      metadata: { nested: { error: new Error('Connection timeout') } },
    });

    expect(capture.entry()).toMatchObject({
      level: 'error',
      message: 'Connection timeout',
      operation: 'database-query',
      error: { message: 'Connection timeout' },
      metadata: { nested: { error: { message: 'Connection timeout' } } },
    });
  });

  it('Case 5: warn/error/fatal(string)', () => {
    logger.warn('Warning message');
    logger.error('Error message');
    logger.fatal('Fatal message');

    expect(capture.entry(0)).toMatchObject({
      level: 'warn',
      message: 'Warning message',
    });
    expect(capture.entry(1)).toMatchObject({
      level: 'error',
      message: 'Error message',
    });
    expect(capture.entry(2)).toMatchObject({
      level: 'fatal',
      message: 'Fatal message',
    });
  });

  it('Case 6: log(string, error)', () => {
    logger.error('Operation failed', new Error('Database connection failed'));

    expect(capture.entry()).toMatchObject({
      level: 'error',
      message: 'Operation failed',
      error: {
        message: 'Database connection failed',
        stack: expect.any(String),
      },
    });
  });

  it('Case 7: log(string, { err })', () => {
    logger.error('API call failed', {
      err: new Error('API rate limit exceeded'),
      retryAfter: 30,
    });

    const entry = capture.entry();
    expect(entry).toMatchObject({
      level: 'error',
      message: 'API call failed',
      error: { message: 'API rate limit exceeded' },
      retryAfter: 30,
    });
    expect(entry).not.toHaveProperty('err');
  });

  it('Case 8: log(string, { error })', () => {
    logger.error('Request invalid', {
      error: new Error('Validation failed'),
      field: 'email',
    });

    expect(capture.entry()).toMatchObject({
      level: 'error',
      message: 'Request invalid',
      error: { message: 'Validation failed' },
      field: 'email',
    });
  });

  it('Case 9: log(string, object with a deeply nested Error)', () => {
    logger.error('Complex operation failed', {
      operation: 'file-upload',
      metadata: {
        size: 1024,
        nested: { deeply: { hiddenError: new Error('File not found') } },
      },
    });

    expect(capture.entry()).toMatchObject({
      level: 'error',
      message: 'Complex operation failed',
      operation: 'file-upload',
      error: { message: 'File not found' },
      metadata: { size: 1024 },
    });
  });
});
