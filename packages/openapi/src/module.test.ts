import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
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
   * The explorer is behind `@dunx/openapi/ui` and reaches the page through a
   * dynamic import, so this is the assertion that the lazy load actually resolves
   * over a real server rather than only in a unit test that imported it eagerly.
   */
  it('serves an HTML page that fetches nothing', async () => {
    const response = await prefixed.request('api/docs');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const page = await response.text();
    expect(page.startsWith('<!doctype html>')).toBe(true);
    // The lazily imported bundle, not an empty `<script>`.
    expect(page.length).toBeGreaterThan(400_000);
    // The document travels in the page, so the explorer boots without a fetch.
    expect(page).toContain('ThingsController_list');
    expect(page).toContain('Every thing');
    expect(page).toContain('"jsonHref":"/api/openapi.json"');
    // The bundle is inlined: no `src=`, no `<link>`, nothing from a CDN. The
    // assertion is on the tags rather than the text because minified React
    // contains both `src=` and a `"<script>"` string of its own.
    expect(page).not.toMatch(/<script[^>]*\ssrc=/);
    expect(page).not.toMatch(/<link\b/);
    expect(page).not.toContain('//cdn');
    expect(page).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
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

  @Module({ imports: [ThingsModule], providers: [DocsConfig] })
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
