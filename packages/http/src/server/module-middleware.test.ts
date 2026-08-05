import { describe, expect, test } from 'bun:test';
import { Module, provide, token } from '@dunx/core';
import type { BunRequest } from 'bun';
import { Controller, Get } from '../route/decorators.js';
import { HttpFactory } from './factory.js';
import type { Middleware, Next } from './middleware.js';
import type { RouteContext } from './context.js';

/**
 * The reason module scoping was worth doing: a module provides middleware for **its
 * own** routes, resolved from **its own** scope.
 *
 * Neither half was expressible before. `HttpOptions.middleware` is one global list, and
 * a flat container had no "its own scope" for a guard to inject from.
 */
const Trail = token<string[]>('Trail');

/** Private to ReportsModule - nothing else can resolve it, which is the point. */
class TenantPolicy {
  readonly name = 'acme';
}

class TenantGuard implements Middleware {
  constructor(
    private readonly policy: TenantPolicy,
    private readonly trail: string[],
  ) {}

  async handle(
    _req: BunRequest,
    _ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    this.trail.push(`tenant:${this.policy.name}`);
    return next();
  }
}

@Controller('reports')
class ReportsController {
  @Get('/')
  list(): { ok: true } {
    return { ok: true };
  }
}

@Controller('public')
class PublicController {
  @Get('/')
  open(): { ok: true } {
    return { ok: true };
  }
}

const build = async (trail: string[]) => {
  @Module({
    controllers: [ReportsController],
    providers: [
      TenantPolicy,
      provide(TenantGuard, {
        useFactory: (policy: TenantPolicy, entries: string[]) =>
          new TenantGuard(policy, entries),
        inject: [TenantPolicy, Trail] as const,
      }),
    ],
    middleware: [TenantGuard],
  })
  class ReportsModule {}

  @Module({ controllers: [PublicController] })
  class PublicModule {}

  @Module({
    imports: [ReportsModule, PublicModule],
    providers: [provide(Trail, { useValue: trail })],
    exports: [Trail],
    global: true,
  })
  class AppModule {}

  return HttpFactory.create(AppModule, { requestLogging: false });
};

describe('module middleware', () => {
  test('runs for the declaring module’s routes and injects its private provider', async () => {
    const trail: string[] = [];
    const app = await build(trail);
    const url = await app.listen(0);

    const response = await fetch(`${url}reports`);
    expect(response.status).toBe(200);
    // Constructed from ReportsModule's scope, so `TenantPolicy` - which no other
    // module can see - resolved.
    expect(trail).toEqual(['tenant:acme']);

    await app.shutdown();
  });

  test('does not run for another module’s routes', async () => {
    const trail: string[] = [];
    const app = await build(trail);
    const url = await app.listen(0);

    const response = await fetch(`${url}public`);
    expect(response.status).toBe(200);
    // There is no ancestor layer and no inheritance: importing ReportsModule did not
    // put its guard in front of PublicModule's routes.
    expect(trail).toEqual([]);

    await app.shutdown();
  });

  test('runs inside global middleware, not outside it', async () => {
    const order: string[] = [];

    class Outer implements Middleware {
      async handle(
        _req: BunRequest,
        _ctx: RouteContext,
        next: Next,
      ): Promise<Response> {
        order.push('global:in');
        const response = await next();
        order.push('global:out');
        return response;
      }
    }

    class Inner implements Middleware {
      async handle(
        _req: BunRequest,
        _ctx: RouteContext,
        next: Next,
      ): Promise<Response> {
        order.push('module');
        return next();
      }
    }

    @Module({
      controllers: [ReportsController],
      providers: [Inner],
      middleware: [Inner],
    })
    class Feature {}

    @Module({ imports: [Feature], providers: [Outer], exports: [Outer] })
    class Root {}

    const app = await HttpFactory.create(Root, {
      middleware: [Outer],
      requestLogging: false,
    });
    const url = await app.listen(0);
    await fetch(`${url}reports`);

    expect(order).toEqual(['global:in', 'module', 'global:out']);
    await app.shutdown();
  });
});
