import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ContextStore } from './context.js';
import {
  captureConsole,
  hasColor,
  parseLogOutput,
  testConfig,
  testLogger,
  withTestContext,
  type Capture,
} from './fixture.test.js';
import { resolveLoggerOptions } from './options.js';
import { colorsSupported } from './colors.js';
import { LogLevel } from './types.js';

describe('ConsoleLogger', () => {
  let capture: Capture;
  let store: ContextStore;
  let logger: ReturnType<typeof testLogger>;

  beforeEach(() => {
    store = new ContextStore();
    logger = testLogger(testConfig, store);
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
  });

  describe('basic logging', () => {
    it('logs a message with nested objects', () => {
      logger.log('Test', { some: { nested: 'value' } });

      expect(capture.entry()).toMatchObject({
        message: 'Test',
        some: { nested: 'value' },
      });
    });

    it('logs debug messages', () => {
      logger.debug('Debug message');

      expect(capture.entry()).toMatchObject({
        level: 'debug',
        message: 'Debug message',
      });
    });

    it('logs warn messages', () => {
      logger.warn('Warning message');

      expect(capture.entry()).toMatchObject({
        level: 'warn',
        message: 'Warning message',
      });
    });

    it('logs verbose messages once the level allows it', () => {
      testLogger({ ...testConfig, level: LogLevel.VERBOSE }, store).verbose(
        'Verbose message',
      );

      expect(capture.entry()).toMatchObject({
        level: 'verbose',
        message: 'Verbose message',
      });
    });

    it('exposes the configured level', () => {
      expect(logger.logLevel).toBe(LogLevel.DEBUG);
    });
  });

  describe('error logging', () => {
    it('logs error messages with Error objects', () => {
      logger.error('Error occurred', new Error('Test error message'));

      expect(capture.entry()).toMatchObject({
        level: 'error',
        message: 'Error occurred',
        error: { message: 'Test error message', stack: expect.any(String) },
      });
    });

    it('logs fatal messages with Error objects', () => {
      logger.fatal('Fatal error occurred', new Error('Fatal error'));

      expect(capture.entry()).toMatchObject({
        level: 'fatal',
        message: 'Fatal error occurred',
        error: { message: 'Fatal error' },
      });
    });

    it('handles an Error after an extra object', () => {
      logger.error(
        'Error with extra data',
        { userId: '123' },
        new Error('Position test'),
      );

      expect(capture.entry()).toMatchObject({
        userId: '123',
        error: { message: 'Position test' },
      });
    });

    it('handles an err property holding an Error', () => {
      logger.error('Nested error', { err: new Error('Nested error') });

      expect(capture.entry()).toMatchObject({
        error: { message: 'Nested error' },
      });
    });

    it('promotes { error: string } at error level', () => {
      logger.error('Some error', { error: 'Request failed with status 500' });

      expect(capture.entry()).toMatchObject({
        level: 'error',
        message: 'Some error',
        error: {
          name: 'Error',
          message: 'Request failed with status 500',
          stack: expect.any(String),
        },
      });
    });

    it('keeps the other properties when { error: string } is promoted', () => {
      logger.error('Some error', { error: 'Request failed', statusCode: 500 });

      expect(capture.entry()).toMatchObject({
        level: 'error',
        message: 'Some error',
        statusCode: 500,
        error: { message: 'Request failed' },
      });
    });

    it('promotes a trailing string at error level', () => {
      logger.error('String error', 'This is a string error');

      expect(capture.entry()).toMatchObject({
        error: { message: 'This is a string error' },
      });
    });

    it('keeps a trailing string as context below error level', () => {
      logger.debug('Debug note', 'extra detail');

      const entry = capture.entry();
      expect(entry).toMatchObject({ context: 'extra detail' });
      expect(entry).not.toHaveProperty('error');
    });
  });

  describe('context and metadata', () => {
    it('includes the async context', () => {
      withTestContext(store, () => {
        logger.log('Test with context');
      });

      expect(capture.entry()).toMatchObject({
        requestId: 'test-request-id',
        userId: 'test-user-id',
        event: '/test',
      });
    });

    it('includes app metadata', () => {
      logger.log('Test app metadata');

      expect(capture.entry()).toMatchObject({
        appId: 'test-app-1.0.0-local',
        pid: process.pid,
        timestamp: expect.any(String),
      });
    });

    it('omits appId unless name, version and env are all configured', () => {
      testLogger({ colors: true, name: 'partial' }, store).log('No appId');

      expect(capture.entry()).not.toHaveProperty('appId');
    });
  });

  describe('log level filtering', () => {
    it('drops entries below the configured level', () => {
      const filtered = testLogger({ ...testConfig, level: LogLevel.ERROR });

      filtered.debug('This should not be logged');
      filtered.log('This should not be logged');
      expect(capture.lines).toHaveLength(0);

      filtered.error('This should be logged');
      expect(capture.lines).toHaveLength(1);
    });
  });

  describe('event filtering', () => {
    it('drops a filtered event', () => {
      store.runWithContext({ event: '/health' }, () => {
        logger.log('Health check');
      });

      expect(capture.lines).toHaveLength(0);
    });

    it('keeps an event that is not filtered', () => {
      store.runWithContext({ event: '/api/users' }, () => {
        logger.log('User request');
      });

      expect(capture.lines).toHaveLength(1);
    });
  });

  describe('colour', () => {
    it('colours the output when colours are enabled', () => {
      logger.log('Coloured test');

      expect(hasColor(capture.line())).toBe(true);
      expect(capture.entry()).toMatchObject({ message: 'Coloured test' });
    });

    it('writes plain, unescaped JSON when colours are disabled', () => {
      testLogger({ ...testConfig, colors: false }).log('Plain test');

      const line = capture.line();
      expect(hasColor(line)).toBe(false);
      expect(line).toMatch(/^\{.*\}$/);
      expect(JSON.parse(line)).toMatchObject({ message: 'Plain test' });
    });

    it('defaults colour to development AND runtime support, never development alone', () => {
      expect(resolveLoggerOptions({ isDevelopment: true }).colors).toBe(
        colorsSupported(),
      );
      expect(resolveLoggerOptions({ isDevelopment: false }).colors).toBe(false);
      // An explicit setting wins over the runtime, in both directions.
      expect(
        resolveLoggerOptions({ isDevelopment: false, colors: true }).colors,
      ).toBe(true);
      expect(
        resolveLoggerOptions({ isDevelopment: true, colors: false }).colors,
      ).toBe(false);
    });
  });
});

/**
 * The failure mode these two guard against is a log file full of escape
 * sequences. Colour support cannot be faked in-process — `Bun.enableANSIColors`
 * is decided by the runtime at startup — so this runs a real Bun with stdout
 * piped and reads back what a redirected process would have written.
 */
const logInSubprocess = async (
  env: Record<string, string>,
): Promise<readonly string[]> => {
  const source = [
    `const dir = ${JSON.stringify(import.meta.dir)};`,
    'const { ConsoleLogger } = await import(`${dir}/console.ts`);',
    'const { ContextStore } = await import(`${dir}/context.ts`);',
    'const { resolveLoggerOptions } = await import(`${dir}/options.ts`);',
    'const options = resolveLoggerOptions({ isDevelopment: true });',
    'new ConsoleLogger(options, new ContextStore())',
    "  .log('piped', { password: 'hunter2' });",
    'console.log(String(Bun.enableANSIColors));',
  ].join('\n');

  const proc = Bun.spawn([process.execPath, '-e', source], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`subprocess exited ${code}: ${err}`);
  return out.trimEnd().split('\n');
};

describe('colour degradation on a piped stdout', () => {
  it('writes clean parseable JSON when NO_COLOR is set', async () => {
    const [entry, supported] = await logInSubprocess({ NO_COLOR: '1' });

    expect(supported).toBe('false');
    expect(entry).toBeDefined();
    expect(hasColor(entry ?? '')).toBe(false);
    expect(JSON.parse(entry ?? '')).toMatchObject({
      message: 'piped',
      password: '[MASKED]',
    });
  });

  it('colours the output when the runtime says colour is supported', async () => {
    const [entry, supported] = await logInSubprocess({ FORCE_COLOR: '1' });

    expect(supported).toBe('true');
    expect(hasColor(entry ?? '')).toBe(true);
    expect(parseLogOutput(entry ?? '')).toMatchObject({ message: 'piped' });
  });
});
