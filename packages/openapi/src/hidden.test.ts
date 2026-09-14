import { expect, test } from 'bun:test';
import { AppFactory, Module } from '@dunx/core';
import { ApiHidden, Controller, Get, HealthModule } from '@dunx/http';
import { describeRoutes } from './discover.js';
import { OpenApiExplorer } from './explorer.js';
import { OpenApiModule } from './module.js';
import { SwaggerRenderer } from './swagger/index.js';

@Controller('users')
class UsersController {
  @Get()
  list(): readonly string[] {
    return [];
  }

  @ApiHidden()
  @Get('internal')
  internal(): string {
    return 'ok';
  }
}

// A wildcard mount: real, routed, and not expressible as a path template.
@ApiHidden()
@Controller('auth')
class MountedAuthHandler {
  @Get('*')
  handle(): string {
    return 'ok';
  }
}

@Module({ controllers: [UsersController, MountedAuthHandler] })
class AppModule {}

test('a hidden route is left out of discovery', () => {
  expect(describeRoutes(AppModule).map((r) => r.path)).toEqual(['/users']);
});

/**
 * The probes are documented by default. They are two paths and a report shape a
 * reader wants to find in the reference, and an orchestrator reads neither the
 * document nor the tag.
 */
test('the health probes are documented by default, under one tag', () => {
  @Module({ imports: [HealthModule.forRoot()] })
  class Root {}

  const routes = describeRoutes(Root);
  expect(routes.map((route) => route.path)).toEqual([
    '/health/live',
    '/health/ready',
  ]);
  // `tagOf` strips the suffix, so both operations land under `Health`.
  expect(new Set(routes.map((route) => route.controller))).toEqual(
    new Set(['HealthController']),
  );
});

test('documented: false serves them and leaves them out', () => {
  @Module({ imports: [HealthModule.forRoot({ documented: false })] })
  class Root {}

  expect(describeRoutes(Root)).toEqual([]);
});

test('routes: false mounts no controller either way', () => {
  @Module({
    imports: [HealthModule.forRoot({ routes: false, documented: true })],
  })
  class Root {}

  expect(describeRoutes(Root)).toEqual([]);
});

/**
 * The explorer's own mount, which is discovered like any controller and then
 * dropped. A generated client had a `getOpenapiJson()` and a `getDocs()` on it,
 * neither describing anything the schemas cover (#152).
 */
test('the explorer documents the app, not itself', async () => {
  @Module({ controllers: [UsersController] })
  class Root {}

  const app = await AppFactory.create(
    OpenApiModule.forRoot({
      title: 'T',
      version: '1',
      root: Root,
      renderer: new SwaggerRenderer(),
    }),
  );

  expect(Object.keys(app.get(OpenApiExplorer).document().paths)).toEqual([
    '/users',
  ]);
  await app.shutdown();
});
