import { expect, test } from 'bun:test';
import { AppFactory, Module } from '@dunx/core';
import { Controller, Get } from '@dunx/http';
import { describeRoutes } from './discover.js';
import { generateDocument } from './generate.js';
import { OpenApiExplorer, OpenApiModule } from './module.js';

@Controller('users')
class UsersController {
  @Get()
  list(): readonly string[] {
    return [];
  }
}

@Module({ controllers: [UsersController] })
class UsersModule {}

// Better Auth serves this itself, at the absolute URL the app mounted it on. It
// is not a dunx controller, so it does not move when the global prefix moves
// them - and prefixing it anyway produced `/api/api/auth/sign-in` silently.
const CONTRIBUTED = '/api/auth/sign-in';

const explorer = async (routes = describeRoutes(UsersModule)) =>
  new OpenApiExplorer(
    await generateDocument(routes, {
      title: 'T',
      version: '1',
      contribute: [
        {
          paths: { [CONTRIBUTED]: { post: { responses: {} } } },
          schemas: {},
          tags: [],
        },
      ],
    }),
    '/openapi.json',
  );

test('a contributed path is not re-prefixed by the mount', async () => {
  const served = await explorer();
  expect(Object.keys(served.document('/api').paths)).toContain(CONTRIBUTED);
  expect(Object.keys(served.document('/api').paths)).not.toContain(
    '/api/api/auth/sign-in',
  );
});

test('while a discovered path still moves with the prefix', async () => {
  const served = await explorer();
  expect(Object.keys(served.document('/api').paths).sort()).toEqual([
    CONTRIBUTED,
    '/api/users',
  ]);
});

test('and neither moves when there is no prefix', async () => {
  const served = await explorer();
  expect(Object.keys(served.document().paths).sort()).toEqual([
    CONTRIBUTED,
    '/users',
  ]);
});

class Auth {
  readonly api = {
    generateOpenAPISchema: async () => ({
      paths: { '/sign-in': { post: { responses: {} } } },
    }),
  };
}

/**
 * `Auth` is exported because `OpenApiModule` wraps this module rather than being
 * imported by it, and the contributor factory it configures runs in *its* scope. A
 * wrapper's factory can only inject what the module it wraps exposes.
 */
@Module({
  controllers: [UsersController],
  providers: [Auth],
  exports: [Auth],
})
class AppModule {}

test('a contributor can inject through forRootAsync', async () => {
  const app = await AppFactory.create(
    OpenApiModule.forRootAsync({
      root: AppModule,
      useFactory: (auth: Auth) => ({
        title: 'T',
        version: '1',
        contribute: [
          async () => {
            const raw = await auth.api.generateOpenAPISchema();
            return { paths: raw.paths, schemas: {}, tags: [] };
          },
        ],
      }),
      inject: [Auth],
    }),
  );

  // The documentation routes are in there too, deliberately - they are routes.
  const paths = Object.keys(app.get(OpenApiExplorer).document().paths).sort();
  expect(paths).toEqual(['/docs', '/openapi.json', '/sign-in', '/users']);
  await app.shutdown();
});
