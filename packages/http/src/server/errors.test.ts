import { describe, expect, it } from 'bun:test';
import { Logger, Module, type LogLevel } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { errorMapper, HttpError, ValidationError } from './errors.js';
import { HttpFactory } from './factory.js';

class CollectingLogger extends Logger {
  readonly logLevel: LogLevel = 'info';
  readonly calls: { level: string; args: readonly unknown[] }[] = [];

  verbose(...args: unknown[]): void {
    this.calls.push({ level: 'verbose', args });
  }
  debug(...args: unknown[]): void {
    this.calls.push({ level: 'debug', args });
  }
  info(...args: unknown[]): void {
    this.calls.push({ level: 'info', args });
  }
  log(...args: unknown[]): void {
    this.calls.push({ level: 'info', args });
  }
  warn(...args: unknown[]): void {
    this.calls.push({ level: 'warn', args });
  }
  error(...args: unknown[]): void {
    this.calls.push({ level: 'error', args });
  }
  fatal(...args: unknown[]): void {
    this.calls.push({ level: 'fatal', args });
  }
}

@Controller('boom')
class BoomController {
  @Get('/')
  boom(): never {
    throw new Error('unhandled');
  }
}

@Module({ controllers: [BoomController] })
class BoomModule {}

/** Every line either stream received, unparsed. */
const rawLines = async (run: () => Promise<void>): Promise<string[]> => {
  const lines: string[] = [];
  const { log, error } = console;
  const record = (...args: unknown[]): void => {
    lines.push(...args.map(String).join(' ').split('\n'));
  };
  console.log = record;
  console.error = record;
  try {
    await run();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines.filter((line) => line.trim() !== '');
};

const request = new Request('http://localhost/boom');

describe('errorMapper', () => {
  it('logs an unmapped error through the logger it was given', () => {
    const logger = new CollectingLogger();
    const cause = new Error('unhandled');
    const response = errorMapper(logger)(cause, request);

    expect(response.status).toBe(500);
    const call = logger.calls.find((entry) => entry.level === 'error');
    expect(call).toBeDefined();
    // The Error itself, not `{ err }` inside an object: that is what makes a
    // logger serialise the stack rather than `JSON.stringify` it to `{}`.
    expect(call?.args).toContain(cause);
  });

  it('says nothing about an HttpError - the status is the whole record', () => {
    const logger = new CollectingLogger();
    const response = errorMapper(logger)(new HttpError(418, 'teapot'), request);

    expect(response.status).toBe(418);
    expect(logger.calls).toEqual([]);
  });

  it('keeps a ValidationError’s issues in the body', async () => {
    const logger = new CollectingLogger();
    const error = new ValidationError('body', [
      { message: 'Required', path: 'name' },
    ]);
    const response = errorMapper(logger)(error, request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid body',
      status: 400,
      issues: [{ message: 'Required', path: 'name' }],
    });
    expect(logger.calls).toEqual([]);
  });

  /**
   * The bug this replaced: one structured entry plus a multi-line Bun-formatted
   * `console.error` dump, which a collector reads as several broken records.
   */
  it('writes nothing but JSON lines for a 500 in a JSON-only service', async () => {
    const lines = await rawLines(async () => {
      const app = await HttpFactory.create(BoomModule, {
        requestLogging: false,
      });
      const url = await app.listen(0);
      try {
        const response = await fetch(new URL('boom', url));
        expect(response.status).toBe(500);
      } finally {
        await app.shutdown();
      }
    });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => !line.startsWith('{'))).toEqual([]);
    const entry = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((e) => e['level'] === 'error');
    expect(entry).toBeDefined();
    expect(
      (entry?.['error'] as { stack?: string } | undefined)?.stack,
    ).toContain('unhandled');
  });
});
