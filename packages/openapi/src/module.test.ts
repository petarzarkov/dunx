import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import {
  Controller,
  Get,
  HttpFactory,
  Post,
  Roles,
  type HttpApp,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
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

const start = async (prefix?: string): Promise<[HttpApp, string]> => {
  const app = await HttpFactory.create(
    OpenApiModule.forRoot({
      title: 'Served API',
      version: '0.3.0',
      description: 'Documented by the app that serves it.',
      root: ThingsModule,
    }),
    { port: 0 },
  );
  if (prefix !== undefined) app.setGlobalPrefix(prefix);
  return [app, await app.listen()];
};

let prefixed: HttpApp;
let prefixedUrl: string;
let plain: HttpApp;
let plainUrl: string;

beforeAll(async () => {
  [prefixed, prefixedUrl] = await start('api');
  [plain, plainUrl] = await start();
});

afterAll(async () => {
  await prefixed.shutdown();
  await plain.shutdown();
});

describe('a real server serving its own document', () => {
  it('answers /openapi.json with the document', async () => {
    const response = await fetch(new URL('api/openapi.json', prefixedUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const document = (await response.json()) as OpenApiDocument;
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Served API');
    expect(danglingRefs(document)).toEqual([]);
  });

  it('documents the paths as the app actually mounted them', async () => {
    const response = await fetch(new URL('api/openapi.json', prefixedUrl));
    const document = (await response.json()) as OpenApiDocument;

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

  it('serves an HTML page that fetches nothing', async () => {
    const response = await fetch(new URL('api/docs', prefixedUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const page = await response.text();
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('ThingsController_list');
    expect(page).toContain('Every thing');
    expect(page).toContain('<a href="/api/openapi.json">');
    expect(page).not.toContain('<script');
    expect(page).not.toContain('cdn');
  });

  it('moves with the global prefix rather than sitting beside it', async () => {
    const response = await fetch(new URL('openapi.json', prefixedUrl));
    expect(response.status).toBe(404);
  });

  it('leaves the paths alone with no global prefix', async () => {
    const response = await fetch(new URL('openapi.json', plainUrl));
    const document = (await response.json()) as OpenApiDocument;

    expect(Object.keys(document.paths).sort()).toEqual([
      '/docs',
      '/openapi.json',
      '/things',
    ]);
  });

  it('exposes the document and its warnings from the container', () => {
    const explorer = prefixed.get(OpenApiExplorer);
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
    const response = await fetch(new URL('api/openapi.json', prefixedUrl));
    const document = (await response.json()) as OpenApiDocument;
    expect(document.paths['/api/openapi.json']?.get?.security).toEqual([]);
    expect(document.paths['/api/things']?.post?.security).toEqual([
      { bearer: [] },
    ]);
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
