import { Module } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { gatewaysOf, routesOf } from './inspect.js';
import { Controller, Get, Post } from './route/decorators.js';
import { ApiHidden, Public, Roles, UseGuards } from './route/metadata.js';
import { Gateway, OnMessage, OnOpen } from './ws/decorators.js';
import type { Middleware, Next } from './server/middleware.js';

/**
 * These readers moved down from `@dunx/mcp` when `@dunx/dashboard` became a second
 * consumer. The half that matters here is the half core cannot do: route metadata,
 * guards, and the gateway marker.
 *
 * The load-bearing property is that **nothing is constructed** - `discoverRoutes`
 * walks a prototype chain, and `Object.create(Controller.prototype)` is that chain
 * with nothing behind it - so a controller whose constructor would throw is still
 * readable.
 */
class Admin implements Middleware {
  handle(_req: never, _ctx: never, next: Next): Promise<Response> {
    return next();
  }
}

@Controller('/notes')
@UseGuards(Admin)
class NotesController {
  constructor() {
    throw new Error('a reader must never call this');
  }

  @Get('/')
  @Public()
  list(): string[] {
    return [];
  }

  @Post('/')
  @Roles('admin')
  create(): string {
    return 'created';
  }

  @Get('/secret')
  @ApiHidden()
  secret(): string {
    return 'shh';
  }
}

/** Every handler records that it ran, so the fixture is inspectable, not empty. */
const seen: string[] = [];

@Gateway('/ws')
class FeedGateway {
  @OnOpen()
  opened(): void {
    seen.push('opened');
  }

  @OnMessage('tick')
  tick(): void {
    seen.push('tick');
  }

  @OnMessage()
  anything(): void {
    seen.push('anything');
  }
}

@Module({ controllers: [NotesController], providers: [FeedGateway] })
class FeatureModule {}

@Module({ imports: [FeatureModule] })
class RootModule {}

describe('routesOf', () => {
  it('reads every route without constructing the controller', () => {
    // NotesController's constructor throws, and this still answers.
    const routes = routesOf(RootModule);
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /notes',
      'POST /notes',
      'GET /notes/secret',
    ]);
  });

  it('carries the metadata a document does not: module, guards, roles', () => {
    const byPath = new Map(
      routesOf(RootModule).map((route) => [
        `${route.method}${route.path}`,
        route,
      ]),
    );

    expect(byPath.get('GET/notes')).toMatchObject({
      module: 'FeatureModule',
      controller: 'NotesController',
      handler: 'list',
      public: true,
      guards: ['Admin'],
      roles: null,
    });
    expect(byPath.get('POST/notes')?.roles).toEqual(['admin']);
    // "Not documented" and "not there" are different, so `hidden` is reported
    // rather than the route being dropped.
    expect(byPath.get('GET/notes/secret')?.hidden).toBe(true);
    expect(byPath.get('GET/notes')?.hidden).toBe(false);
  });
});

describe('gatewaysOf', () => {
  it('reads the path and each handler off the prototype', () => {
    const [gateway] = gatewaysOf(RootModule);
    expect(gateway).toMatchObject({
      name: 'FeedGateway',
      path: '/ws',
      module: 'FeatureModule',
    });
    expect(gateway?.handlers).toEqual([
      { kind: 'open', event: null, method: 'opened' },
      { kind: 'message', event: 'tick', method: 'tick' },
      // The raw catch-all that sees every unrouted frame - null, not a name.
      { kind: 'message', event: null, method: 'anything' },
    ]);
  });

  it('ignores a provider that is not marked', () => {
    class Plain {}
    @Module({ providers: [Plain] })
    class NoGateways {}
    expect(gatewaysOf(NoGateways)).toEqual([]);
  });
});
