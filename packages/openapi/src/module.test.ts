import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Module, provide, token } from '@dunx/core';
import {
  Controller,
  Get,
  Post,
  Roles,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import { createTestServer, type TestServer } from '@dunx/testing';
import { z } from 'zod';
import { ApiDoc } from './metadata.js';
import { OpenApiExplorer, OpenApiModule } from './module.js';
import { mountPrefix, withPrefix } from './mount.js';
import { danglingRefs } from './refs.js';
import type { OpenApiDocument } from './types.js';

const CreateThing = z
  .object({ name: z.string().min(1) })
  .meta({ id: 'CreateThing', title: 'Make a thing' });

const createThing = { body: CreateThing } as const satisfies RouteSchemas;

@Controller('things')
class ThingsController {
  @ApiDoc({ summary: 'Every thing' })
  @Get('/')
  list(): readonly string[] {
    return ['one'];
  }

  @Roles('admin')
  @Post('/', createThing)
  create(input: Input<typeof createThing>): string {
    return input.body.name;
  }
}

@Module({ controllers: [ThingsController] })
class ThingsModule {}

/**
 * `@dunx/testing` from another published package's tests. It was blocked by build
 * ordering - `--filter '*'` sorted by `dependencies` alone and raced testing's
 * `.d.ts` emit - and `scripts/build-all.ts` sorting by every kind of edge is what
 * unblocked it. The dev edge here is what keeps that ordering honest.
 */
const start = (prefix?: string): Promise<TestServer> =>
  createTestServer({
    modules: OpenApiModule.forRoot({
      title: 'Served API',
      version: '0.3.0',
      description: 'Documented by the app that serves it.',
      root: ThingsModule,
    }),
    prefix,
  });

let prefixed: TestServer;
let plain: TestServer;

beforeAll(async () => {
  prefixed = await start('api');
  plain = await start();
});

afterAll(async () => {
  await prefixed.close();
  await plain.close();
});

describe('a real server serving its own document', () => {
  it('answers /openapi.json with the document', async () => {
    const { status, headers, body } =
      await prefixed.json<OpenApiDocument>('api/openapi.json');
    expect(status).toBe(200);
    expect(headers.get('content-type')).toContain('application/json');

    expect(body.openapi).toBe('3.1.0');
    expect(body.info.title).toBe('Served API');
    expect(danglingRefs(body)).toEqual([]);
  });

  it('documents the paths as the app actually mounted them', async () => {
    const { body: document } =
      await prefixed.json<OpenApiDocument>('api/openapi.json');

    // The global prefix is applied after the container is built, so it is derived
    // from the document route's own URL.
    expect(Object.keys(document.paths).sort()).toEqual([
      '/api/docs',
      '/api/openapi.json',
      '/api/things',
    ]);
    expect(document.paths['/api/things']?.post?.operationId).toBe(
      'ThingsController_create',
    );
  });

  /**
   * The page is now a Swagger UI shell rather than an inlined bundle, so what this
   * asserts over a real server is that its two assets resolve **through the mount
   * prefix**. That is the part a unit test cannot check: `setGlobalPrefix('api')`
   * moves the page, and an asset href computed from the declared path rather than
   * the served one would 404 for every consumer who sets a prefix.
   */
  it('serves a shell whose assets resolve under the prefix', async () => {
    const response = await prefixed.request('api/docs');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const page = await response.text();
    expect(page.startsWith('<!doctype html>')).toBe(true);
    // A shell, not a bundle. The old inlined page was over 400 KB.
    expect(page.length).toBeLessThan(50_000);
    // The document travels in the page, so Swagger UI boots without a fetch.
    expect(page).toContain('ThingsController_list');
    expect(page).toContain('Every thing');
    expect(page).toContain('href="/api/openapi.json"');
    // Three assets are linked from the page and prefixed.
    for (const file of [
      'swagger-ui-bundle.js',
      'swagger-ui.css',
      'favicon-32x32.png',
    ]) {
      expect(page).toContain(`/api/docs/${file}?v=`);
    }
    // Four answer. `swagger-ui.css.map` is not linked from the page - the CSS
    // asks for it with a `sourceMappingURL`, resolved relative to the CSS URL,
    // which is why it has to live under the same prefix.
    for (const file of [
      'swagger-ui-bundle.js',
      'swagger-ui.css',
      'swagger-ui.css.map',
      'favicon-32x32.png',
    ]) {
      const asset = await prefixed.request(`api/docs/${file}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toContain('immutable');
      expect(Number(asset.headers.get('content-length'))).toBeGreaterThan(500);
    }
    // A name off the allow-list is a 404, not a read out of node_modules.
    for (const name of ['swagger-ui-es-bundle.js', 'package.json']) {
      expect((await prefixed.request(`api/docs/${name}`)).status).toBe(404);
    }
    // Nothing leaves the origin.
    for (const [, url] of page.matchAll(
      /<(?:script|link)\b[^>]*\s(?:src|href)="([^"]*)"/g,
    )) {
      expect(url?.startsWith('/')).toBe(true);
    }
    expect(page).not.toContain('//cdn');
    expect(page).not.toContain('petstore.swagger.io');
  });

  /** The assets are routed but are not API, so the document must not list them. */
  it('keeps the assets out of the document', async () => {
    const { body: document } =
      await prefixed.json<OpenApiDocument>('api/openapi.json');
    for (const path of Object.keys(document.paths)) {
      expect(path).not.toContain('swagger-ui');
    }
  });

  it('moves with the global prefix rather than sitting beside it', async () => {
    const response = await prefixed.request('openapi.json');
    expect(response.status).toBe(404);
  });

  it('leaves the paths alone with no global prefix', async () => {
    const { body: document } =
      await plain.json<OpenApiDocument>('openapi.json');

    expect(Object.keys(document.paths).sort()).toEqual([
      '/docs',
      '/openapi.json',
      '/things',
    ]);
  });

  it('exposes the document and its warnings from the container', () => {
    const explorer = prefixed.app.get(OpenApiExplorer);
    expect(explorer.warnings).toEqual([]);
    expect(Object.keys(explorer.document().paths)).toContain('/things');
    expect(Object.keys(explorer.document('/api').paths)).toContain(
      '/api/things',
    );
    expect(
      explorer.document('/api').components.schemas['CreateThing'],
    ).toBeDefined();
  });

  it('documents its own routes as public, so a global guard is not implied', async () => {
    const { body: document } =
      await prefixed.json<OpenApiDocument>('api/openapi.json');
    expect(document.paths['/api/openapi.json']?.get?.security).toEqual([]);
    expect(document.paths['/api/things']?.post?.security).toEqual([
      { bearer: [] },
    ]);
  });
});

/**
 * Every other configurable module has a `forRootAsync` for exactly this: the one
 * thing a zero-argument factory cannot do is read its options off another
 * provider. Without it `title`, `version`, `description`, `path` and `jsonPath`
 * are the only configuration in an app that cannot come from validated config.
 */
describe('forRootAsync', () => {
  class DocsConfig {
    readonly title = 'Configured API';
    readonly version = '9.9.9';
    readonly path = '/reference';
    readonly jsonPath = '/reference.json';
  }

  // Exported so the wrapping OpenApiModule's factory can inject it.
  @Module({
    imports: [ThingsModule],
    providers: [DocsConfig],
    exports: [DocsConfig],
  })
  class ConfiguredModule {}

  const startAsync = (): Promise<TestServer> =>
    createTestServer({
      modules: OpenApiModule.forRootAsync({
        root: ConfiguredModule,
        useFactory: (config: DocsConfig) => ({
          title: config.title,
          version: config.version,
          path: config.path,
          jsonPath: config.jsonPath,
        }),
        inject: [DocsConfig] as const,
      }),
    });

  /**
   * `imports: [options.root]` covers a provider the root exports, which is what the
   * test below uses. It does not cover one the root never sees: this module is its
   * own scope, so the caller's own `imports` are what put that in reach.
   *
   * A `token()` rather than a class: an unbound class self-binds into whichever
   * scope asks first, so a class resolves whether or not `imports` reached the
   * factory, and the test would pass against the bug it guards.
   */
  it('injects from a module named in its own imports, not only from the root', async () => {
    const TITLE = token<string>('DocTitle');

    @Module({
      providers: [provide(TITLE, { useValue: 'From Imports' })],
      exports: [TITLE],
    })
    class TitleModule {}

    @Module({ imports: [ThingsModule] })
    class PlainRoot {}

    const server = await createTestServer({
      modules: OpenApiModule.forRootAsync({
        root: PlainRoot,
        imports: [TitleModule],
        useFactory: (title: string) => ({ title, version: '2.0.0' }),
        inject: [TITLE],
      }),
    });

    try {
      const { status, body: document } =
        await server.json<OpenApiDocument>('openapi.json');

      expect(status).toBe(200);
      expect(document.info.title).toBe('From Imports');
      expect(document.info.version).toBe('2.0.0');
    } finally {
      await server.close();
    }
  });

  it('takes info off a provider, and mounts where that provider says', async () => {
    const server = await startAsync();
    try {
      const { status, body: document } =
        await server.json<OpenApiDocument>('reference.json');
      expect(status).toBe(200);

      expect(document.info.title).toBe('Configured API');
      expect(document.info.version).toBe('9.9.9');
      // The configured paths are the paths the document describes: they are
      // routes, discovered like any other.
      expect(Object.keys(document.paths).sort()).toEqual([
        '/reference',
        '/reference.json',
        '/things',
      ]);
      expect((await server.request('openapi.json')).status).toBe(404);
      expect((await server.request('reference')).status).toBe(200);
      expect(server.app.get(OpenApiExplorer).warnings).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe('mountPrefix', () => {
  it('reads the prefix off the served path', () => {
    expect(mountPrefix('/api/openapi.json', '/openapi.json')).toBe('/api');
    expect(mountPrefix('/v1/api/docs', '/docs')).toBe('/v1/api');
  });

  it('is empty when the route was mounted where it was declared', () => {
    expect(mountPrefix('/openapi.json', '/openapi.json')).toBe('');
  });

  it('is empty rather than wrong when the paths do not line up', () => {
    expect(mountPrefix('/openapi', '/openapi.json')).toBe('');
  });
});

describe('withPrefix', () => {
  const document: OpenApiDocument = {
    openapi: '3.1.0',
    info: { title: 'x', version: '1' },
    paths: { '/': { get: { operationId: 'a', responses: {} } } },
    components: { schemas: {} },
  };

  it('joins the way the app joins, so a root route does not gain a slash', () => {
    expect(Object.keys(withPrefix(document, '/api').paths)).toEqual(['/api']);
    expect(Object.keys(withPrefix(document, '').paths)).toEqual(['/']);
  });
});
