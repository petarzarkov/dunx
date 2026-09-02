import { describe, expect, it } from 'bun:test';
import { AppError, ConsoleLogger, type Logger } from '@dunx/core';
import { errorMapper } from './errors.js';

/** Records what the mapper logged, so a 4xx logged as an incident is visible. */
class RecordingLogger extends ConsoleLogger {
  readonly errors: string[] = [];
  override error(message: unknown, ...rest: unknown[]): void {
    this.errors.push(String(message));
    void rest;
  }
}

/**
 * What a package with no business importing `@dunx/http` can declare: an integer.
 * `CursorError` and `PageOptionsError` in `@dunx/infra/pagination` are this shape.
 */
class OutsideError extends AppError {
  override readonly name = 'OutsideError';
  constructor(
    message: string,
    override readonly status: number,
  ) {
    super(message);
  }
}

const map = async (
  error: unknown,
  logger: Logger = new ConsoleLogger(),
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await errorMapper(logger)(error, new Request('http://x/'));
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

describe('an AppError that named a status', () => {
  it('becomes that status, without importing the web layer to say so', async () => {
    const { status, body } = await map(new OutsideError('bad cursor', 400));

    expect(status).toBe(400);
    expect(body['status']).toBe(400);
    expect(body['error']).toBe('bad cursor');
  });

  it('does not log a 4xx as an incident', async () => {
    const logger = new RecordingLogger();
    await map(new OutsideError('bad cursor', 400), logger);

    // The caller's mistake, not the server's. Logging it at error level is how a
    // log fills with entries nobody can act on.
    expect(logger.errors).toEqual([]);
  });

  it('still logs a 5xx it was handed', async () => {
    const logger = new RecordingLogger();
    const { status } = await map(
      new OutsideError('upstream gone', 502),
      logger,
    );

    expect(status).toBe(502);
    expect(logger.errors).toEqual(['Unhandled error']);
  });

  it('sends an AppError with no status to 500, message withheld', async () => {
    const { status, body } = await map(new AppError('internal detail'));

    expect(status).toBe(500);
    // A boot failure is not a response, and its message is not the caller's.
    expect(body['error']).toBe('Internal Server Error');
  });

  it('sends a plain Error to 500', async () => {
    expect((await map(new Error('boom'))).status).toBe(500);
  });
});

describe('a status that could not be a response', () => {
  // The integer is set by hand in a package that never sees `Response`, so a typo
  // reaching `Response.json` would be a RangeError thrown from the error path.
  for (const bad of [0, 99, 600, 4000, -1, 1.5, Number.NaN]) {
    it(`falls back to 500 rather than throwing on ${bad}`, async () => {
      const { status } = await map(new OutsideError('typo', bad));

      expect(status).toBe(500);
    });
  }

  it('accepts the edges that are real', async () => {
    expect((await map(new OutsideError('a', 200))).status).toBe(200);
    expect((await map(new OutsideError('b', 599))).status).toBe(599);
  });
});
