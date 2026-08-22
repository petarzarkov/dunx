import { Logger, Module } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import type { Input, RouteSchemas } from '../route/schema.js';
import { HttpError } from './errors.js';
import { HttpFactory, type HttpApp } from './factory.js';

/**
 * Captures both streams: warn and above go to stderr by design. One `console.log`
 * may carry several entries - `ConsoleLogger` batches everything at `info` and
 * below into one write per event-loop turn - so each call is split back apart.
 * `withApp` shuts the app down inside `run`, and that flushes what is pending.
 */
export const captured = async (
  run: () => Promise<void>,
): Promise<Record<string, unknown>[]> => {
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
  return lines
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

/**
 * A Standard Schema by hand, the way `input.test.ts` does it. `@dunx/http` depends
 * on no validator, so the shared-body path has to be proven against the interface.
 */
export const validated = {
  body: {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (value: unknown) => {
        const name =
          typeof value === 'object' && value !== null
            ? (value as Record<string, unknown>)['name']
            : undefined;
        return typeof name === 'string' && name.length > 0
          ? { value: { name } }
          : { issues: [{ message: 'name must be a non-empty string' }] };
      },
    },
  },
} as const;

@Controller('things')
class ThingsController {
  @Get('/')
  list(): readonly string[] {
    return ['one'];
  }

  @Post('/')
  create(input: Input<RouteSchemas>): Promise<unknown> {
    return input.req.json();
  }

  /**
   * Declares a `body` schema, so the input reader parses it and `RawBody` holds the
   * text - the path where logging the body costs no `Request.clone()`. `POST /`
   * above declares none and is the clone fallback.
   */
  @Post('/validated', validated)
  validated(input: Input<typeof validated>): { name: string } {
    return { name: input.body.name };
  }

  @Get('/boom')
  boom(): never {
    throw new HttpError(418, 'teapot');
  }

  @Get('/broken')
  broken(): never {
    throw new Error('unhandled');
  }

  /** Proves the handler's own entries inherit the request scope. */
  @Get('/inner')
  inner(): { ok: true } {
    handlerLogger.current?.info('from the handler');
    return { ok: true };
  }
}

/** Set from the container by the test that asserts a handler inherits the scope. */
export const handlerLogger: { current: Logger | undefined } = {
  current: undefined,
};

@Module({ controllers: [ThingsController] })
class ThingsModule {}

export const withApp = async (
  run: (app: HttpApp, url: string) => Promise<void>,
  options: Parameters<typeof HttpFactory.create>[1] = {},
): Promise<void> => {
  const app = await HttpFactory.create(ThingsModule, options);
  const url = await app.listen(0);
  try {
    await run(app, url);
  } finally {
    await app.shutdown();
  }
};
