import { describe, expect, test } from 'bun:test';
import { Logger, Module, provide } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { HttpFactory } from './factory.js';
import {
  ErrorFilter,
  HttpError,
  isErrorFilter,
  toErrorMapper,
  type ErrorMapper,
} from './errors.js';
import { HttpStatusCode } from './status.js';

/**
 * `onError` accepts a class as well as a function, and the class is resolved from
 * the container - which is the whole point of it: a mapper is a bare function and
 * cannot inject, so the interesting filters had nowhere to get a `Logger` or the
 * app's config from.
 */
class Boom extends Error {
  override name = 'Boom';
}

@Controller('things')
class ThingsController {
  @Get('/boom')
  boom(): never {
    throw new Boom('it broke');
  }

  @Get('/teapot')
  teapot(): never {
    throw new HttpError(418, 'I am a teapot');
  }
}

/** Injects, which is the capability a function-shaped mapper does not have. */
class RecordingFilter extends ErrorFilter {
  static seen: string[] = [];

  constructor(private readonly logger: Logger) {
    super();
  }

  override catch(error: unknown, req: Request): Response {
    RecordingFilter.seen.push(`${new URL(req.url).pathname}:${String(error)}`);
    // Proves the injected dependency is the real bound one.
    this.logger.debug('filtered', { name: (error as Error).name });
    const status =
      error instanceof HttpError
        ? error.status
        : HttpStatusCode.INTERNAL_SERVER_ERROR;
    return Response.json({ handledBy: 'RecordingFilter', status }, { status });
  }
}

/**
 * Bound with `provide` rather than listed bare, because this package's own tests run
 * without `@dunx/transform` - core's missing-transform test asserts the
 * un-transformed state, so the root suite has no preload. An app with the plugin
 * writes `providers: [RecordingFilter]` and gets the same wiring for free.
 */
@Module({
  controllers: [ThingsController],
  providers: [
    provide(RecordingFilter, {
      useFactory: (logger: Logger) => new RecordingFilter(logger),
      inject: [Logger] as const,
    }),
  ],
})
class ThingsModule {}

describe('isErrorFilter', () => {
  test('tells a class from a mapper function', () => {
    const mapper: ErrorMapper = () => new Response(null, { status: 500 });
    function named(): Response {
      return new Response(null, { status: 500 });
    }

    expect(isErrorFilter(RecordingFilter)).toBe(true);
    expect(isErrorFilter(mapper)).toBe(false);
    // The case a `prototype` check alone would get wrong: a `function` expression
    // has one, it is just empty.
    expect(isErrorFilter(named as unknown as ErrorMapper)).toBe(false);
  });
});

describe('toErrorMapper', () => {
  test('passes a mapper through untouched', () => {
    const mapper: ErrorMapper = () => new Response('m', { status: 500 });
    expect(
      toErrorMapper(mapper, () => {
        throw new Error('should not resolve');
      }),
    ).toBe(mapper);
  });

  test('resolves a class through the supplied resolver, once per call', () => {
    class Plain extends ErrorFilter {
      override catch(): Response {
        return new Response(null, { status: 507 });
      }
    }
    let asked = 0;
    const mapped = toErrorMapper(Plain, () => {
      asked += 1;
      return new Plain();
    });

    expect(mapped(new Boom('x'), new Request('http://x/y')).status).toBe(507);
    expect(asked).toBe(1);
    // Looked up per call, which is what lets a filter be rebound in a test.
    mapped(new Boom('y'), new Request('http://x/z'));
    expect(asked).toBe(2);
  });
});

describe('HttpOptions.onError as a class', () => {
  test('an unhandled error goes through the filter, which injected its Logger', async () => {
    RecordingFilter.seen = [];
    const app = await HttpFactory.create(ThingsModule, {
      onError: RecordingFilter,
      requestLogging: false,
    });
    const url = await app.listen(0);

    const response = await fetch(`${url}things/boom`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      handledBy: 'RecordingFilter',
      status: 500,
    });
    expect(RecordingFilter.seen).toHaveLength(1);
    expect(RecordingFilter.seen[0]).toContain('/things/boom');

    await app.shutdown();
  });

  test('an HttpError reaches it too, so the filter owns every status', async () => {
    RecordingFilter.seen = [];
    const app = await HttpFactory.create(ThingsModule, {
      onError: RecordingFilter,
      requestLogging: false,
    });
    const url = await app.listen(0);

    const response = await fetch(`${url}things/teapot`);
    expect(response.status).toBe(418);
    expect(await response.json()).toEqual({
      handledBy: 'RecordingFilter',
      status: 418,
    });

    await app.shutdown();
  });

  /**
   * A filter with no dependencies needs no `providers` entry: resolving a class the
   * container can construct **self-binds** it, which is the same rule that lets a
   * service be reached through a constructor without being listed. One that does have
   * dependencies still needs them bindable, so the failure mode is a missing
   * dependency rather than a missing filter.
   */
  test('a dependency-free filter needs no providers entry', async () => {
    class Unlisted extends ErrorFilter {
      override catch(): Response {
        return Response.json({ handledBy: 'Unlisted' }, { status: 507 });
      }
    }
    @Module({ controllers: [ThingsController] })
    class Bare {}

    const app = await HttpFactory.create(Bare, {
      onError: Unlisted,
      requestLogging: false,
    });
    const url = await app.listen(0);

    const response = await fetch(`${url}things/boom`);
    expect(response.status).toBe(507);
    expect(await response.json()).toEqual({ handledBy: 'Unlisted' });

    await app.shutdown();
  });

  test('a plain mapper still works, so nothing about this is breaking', async () => {
    const app = await HttpFactory.create(ThingsModule, {
      onError: () => Response.json({ handledBy: 'fn' }, { status: 503 }),
      requestLogging: false,
    });
    const url = await app.listen(0);

    const response = await fetch(`${url}things/boom`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ handledBy: 'fn' });

    await app.shutdown();
  });
});
