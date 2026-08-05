import { describe, expect, test } from 'bun:test';
import { ConsoleLogger, Logger, Module, provide, token } from '@dunx/core';
import type { BunRequest } from 'bun';
import { Controller, Get } from '../route/decorators.js';
import { UseGuards } from '../route/metadata.js';
import type { Input, RouteSchemas, StandardSchemaV1 } from '../route/schema.js';
import type { RouteContext } from './context.js';
import { ErrorFilter, HttpError } from './errors.js';
import { HttpFactory } from './factory.js';
import type { Middleware, Next } from './middleware.js';
import { HttpStatusCode } from './status.js';

/**
 * The whole request lifecycle in one assertion, because the order is a contract and
 * it is spread across `application.ts` (the global list), `routes.ts` (the chain)
 * and `input.ts` (validation). Nest documents nine numbered stages over five
 * concepts; every layer below is the same `Middleware` wrapping `next()`, and this
 * test is what says so.
 *
 * Each entry records `:in` before `next()` and `:out` after, in a `finally`, so the
 * error test sees the unwind too.
 */
const Trail = token<string[]>('Trail');

class Layer implements Middleware {
  constructor(
    private readonly name: string,
    private readonly trail: string[],
  ) {}

  async handle(
    _req: BunRequest,
    _ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    this.trail.push(`${this.name}:in`);
    try {
      return await next();
    } finally {
      this.trail.push(`${this.name}:out`);
    }
  }
}

const layer = (name: string) =>
  class extends Layer {
    constructor(trail: string[]) {
      super(name, trail);
    }
  };

const Global = layer('global');
const Used = layer('use');
const ModuleLayer = layer('module');
const ControllerGuard = layer('controller-guard');
const MethodGuard = layer('method-guard');

/** Refuses before the handler, and before validation ever reads the request. */
class Refusing implements Middleware {
  constructor(private readonly trail: string[]) {}

  handle(): Promise<Response> {
    this.trail.push('method-guard:refuse');
    throw new HttpError(HttpStatusCode.FORBIDDEN, 'nope');
  }
}

/** A schema exists to pin *where* validation runs, so it validates nothing. */
const recording = (trail: string[]): StandardSchemaV1 => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value: unknown) => {
      trail.push('validate');
      return { value };
    },
  },
});

/** Only the last write matters here: request logging is meant to be outermost. */
class TrailLogger extends ConsoleLogger {
  constructor(private readonly trail: string[]) {
    super(undefined, 'info', false);
  }

  override info(): void {
    this.trail.push('log');
  }

  override warn(): void {
    this.trail.push('log');
  }

  override error(): void {
    this.trail.push('log');
  }
}

class TrailFilter extends ErrorFilter {
  constructor(private readonly trail: string[]) {
    super();
  }

  catch(error: unknown): Response {
    this.trail.push('filter');
    const status =
      error instanceof HttpError
        ? error.status
        : HttpStatusCode.INTERNAL_SERVER_ERROR;
    return Response.json({ filtered: true }, { status });
  }
}

const fromTrail = <T>(build: (trail: string[]) => T) =>
  ({ useFactory: build, inject: [Trail] as const }) as const;

const build = async (
  trail: string[],
  guard: typeof MethodGuard | typeof Refusing,
) => {
  const schemas = { query: recording(trail) } as const satisfies RouteSchemas;

  @UseGuards(ControllerGuard)
  @Controller('reports')
  class ReportsController {
    @UseGuards(guard)
    @Get('/', schemas)
    list(_input: Input<typeof schemas>): { ok: true } {
      trail.push('handler');
      return { ok: true };
    }
  }

  @Module({
    controllers: [ReportsController],
    providers: [
      provide(
        ModuleLayer,
        fromTrail((t) => new ModuleLayer(t)),
      ),
      provide(
        ControllerGuard,
        fromTrail((t) => new ControllerGuard(t)),
      ),
      provide(
        guard,
        fromTrail((t) => new guard(t)),
      ),
    ],
    middleware: [ModuleLayer],
  })
  class ReportsModule {}

  @Module({
    imports: [ReportsModule],
    providers: [
      provide(Trail, { useValue: trail }),
      provide(
        Logger,
        fromTrail((t) => new TrailLogger(t)),
      ),
      provide(
        Global,
        fromTrail((t) => new Global(t)),
      ),
      provide(
        Used,
        fromTrail((t) => new Used(t)),
      ),
      provide(
        TrailFilter,
        fromTrail((t) => new TrailFilter(t)),
      ),
    ],
    exports: [Trail, Logger],
    global: true,
  })
  class AppModule {}

  const app = await HttpFactory.create(AppModule, {
    middleware: [Global],
    onError: TrailFilter,
  });
  return app.use(Used);
};

describe('request lifecycle', () => {
  test('runs every layer in the documented order, then unwinds', async () => {
    const trail: string[] = [];
    const app = await build(trail, MethodGuard);
    const url = await app.listen(0);

    const response = await fetch(`${url}reports`);
    expect(response.status).toBe(200);

    // Request logging is outermost, so its entry is the last thing written - which
    // is what lets it record the status a guard refused with.
    expect(trail).toEqual([
      'global:in',
      'use:in',
      'module:in',
      'controller-guard:in',
      'method-guard:in',
      'validate',
      'handler',
      'method-guard:out',
      'controller-guard:out',
      'module:out',
      'use:out',
      'global:out',
      'log',
    ]);

    await app.shutdown();
  });

  test('a guard that refuses skips validation and the handler, and the filter is outermost', async () => {
    const trail: string[] = [];
    const app = await build(trail, Refusing);
    const url = await app.listen(0);

    const response = await fetch(`${url}reports`);
    expect(response.status).toBe(HttpStatusCode.FORBIDDEN);
    expect(await response.json()).toEqual({ filtered: true });

    // No `validate`, no `handler`: `next()` was never called, so the input reader
    // never read the request. Every enclosing layer still unwinds, and the filter
    // runs outside all of them - it is the only layer that turns a throw into a
    // response.
    expect(trail).toEqual([
      'global:in',
      'use:in',
      'module:in',
      'controller-guard:in',
      'method-guard:refuse',
      'controller-guard:out',
      'module:out',
      'use:out',
      'global:out',
      'log',
      'filter',
    ]);

    await app.shutdown();
  });
});
