import { afterEach, describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import {
  Controller,
  Deprecated,
  Get,
  Version,
  VERSION_NEUTRAL,
} from '@dunx/http';
import { RouteVersioning } from '@dunx/http/internal';
import { createTestServer, type TestServer } from '@dunx/testing';
import { describeRoutes } from './discover.js';
import { generateDocument } from './generate.js';
import { generateDocuments } from './versions.js';
import { SwaggerRenderer } from './swagger/index.js';
import { ApiDoc } from './metadata.js';
import { OpenApiModule } from './module.js';
import type { OpenApiDocument } from './types.js';

@Deprecated({ since: '2026-01-01', sunset: '2027-01-01' })
@Controller('users', { version: '1' })
class UsersV1Controller {
  @Get(':id')
  one(): string {
    return 'v1';
  }
}

@Controller('users', { version: '2' })
class UsersV2Controller {
  @Get(':id')
  one(): string {
    return 'v2';
  }

  @Version(['2', '3'])
  @Get('')
  list(): readonly string[] {
    return [];
  }

  @ApiDoc({ deprecated: true })
  @Get('legacy')
  legacy(): string {
    return '';
  }
}

@Controller('plain')
class PlainController {
  @Get('')
  get(): string {
    return 'plain';
  }
}

@Module({
  controllers: [UsersV1Controller, UsersV2Controller, PlainController],
})
class AppModule {}

const info = { title: 'Versioned', version: '1.0.0' };

describe('versioned routes in the document', () => {
  it('lists each version at its own path, with a distinct operationId', async () => {
    const { document } = await generateDocument(
      describeRoutes(AppModule, RouteVersioning.of({ type: 'uri' })),
      info,
    );

    expect(Object.keys(document.paths).sort()).toEqual([
      '/plain',
      '/v1/users/{id}',
      '/v2/users',
      '/v2/users/legacy',
      '/v2/users/{id}',
      '/v3/users',
    ]);
    expect(document.paths['/v2/users']?.get?.operationId).toBe(
      'UsersV2Controller_list_v2',
    );
    expect(document.paths['/v3/users']?.get?.operationId).toBe(
      'UsersV2Controller_list_v3',
    );
    expect(document.paths['/plain']?.get?.operationId).toBe(
      'PlainController_get',
    );
  });

  it('marks @Deprecated and @ApiDoc({ deprecated }) operations deprecated', async () => {
    const { document } = await generateDocument(
      describeRoutes(AppModule, RouteVersioning.of({ type: 'uri' })),
      info,
    );

    expect(document.paths['/v1/users/{id}']?.get?.deprecated).toBe(true);
    expect(document.paths['/v2/users/legacy']?.get?.deprecated).toBe(true);
    expect(document.paths['/v2/users/{id}']?.get?.deprecated).toBeUndefined();
  });
});

describe('the served document', () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reads the app's versioning, prefix and defaultVersion included", async () => {
    server = await createTestServer({
      modules: OpenApiModule.forRoot({ ...info, root: AppModule }),
      versioning: { type: 'uri', defaultVersion: '1' },
      prefix: 'api',
    });

    const document = (await (
      await server.request('/api/openapi.json')
    ).json()) as OpenApiDocument;

    expect(Object.keys(document.paths)).toContain('/api/v1/plain');
    expect(Object.keys(document.paths)).toContain('/api/v1/users/{id}');
    expect(Object.keys(document.paths)).not.toContain('/api/v1/openapi.json');
    expect((await server.request('/api/v1/plain')).status).toBe(200);
  });

  it('forRootAsync reads it too', async () => {
    server = await createTestServer({
      modules: OpenApiModule.forRootAsync({
        root: AppModule,
        useFactory: () => info,
      }),
      versioning: { type: 'uri', defaultVersion: '4' },
    });

    const document = (await (
      await server.request('/openapi.json')
    ).json()) as OpenApiDocument;

    expect(Object.keys(document.paths)).toContain('/v4/plain');
  });
});

describe('one document per version under header versioning', () => {
  const header = RouteVersioning.of({
    type: 'header',
    header: 'X-API-Version',
    defaultVersion: '2',
  });

  it('holds each version and every unversioned route', async () => {
    const { document, versions } = await generateDocuments(
      describeRoutes(AppModule, header),
      info,
      header,
    );

    expect([...(versions?.documents.keys() ?? [])]).toEqual(['1', '2', '3']);
    expect(versions?.primary).toBe('2');
    // `/plain` declares nothing, so it takes the default version.
    expect(Object.keys(document.document.paths).sort()).toEqual([
      '/plain',
      '/users',
      '/users/legacy',
      '/users/{id}',
    ]);
    const v1 = versions?.documents.get('1')?.document;
    expect(Object.keys(v1?.paths ?? {})).toEqual(['/users/{id}']);
    expect(v1?.paths['/users/{id}']?.get?.deprecated).toBe(true);
    expect(v1?.paths['/users/{id}']?.get?.parameters?.[0]).toEqual({
      name: 'X-API-Version',
      in: 'header',
      required: true,
      schema: { type: 'string', const: '1' },
    });
    // The default version needs no header.
    expect(
      document.document.paths['/users/{id}']?.get?.parameters?.[0]?.required,
    ).toBe(false);
  });

  it('serves the highest version when there is no default, and no header under media type', async () => {
    const media = RouteVersioning.of({ type: 'media-type', key: 'v=' });
    const { versions } = await generateDocuments(
      describeRoutes(AppModule, media),
      info,
      media,
    );

    expect(versions?.primary).toBe('3');
    expect(
      versions?.documents.get('3')?.document.paths['/users']?.get?.parameters,
    ).toBeUndefined();
  });

  it('a version replaces the neutral route on its path, which the others keep', async () => {
    @Controller('things')
    class NeutralThings {
      @Version(VERSION_NEUTRAL)
      @Get('')
      list(): string {
        return 'neutral';
      }
    }
    @Controller('things', { version: '1' })
    class ThingsV1 {
      @Get('')
      list(): string {
        return 'v1';
      }
    }
    @Controller('things', { version: '2' })
    class ThingsV2 {
      @Get(':id')
      one(): string {
        return 'v2';
      }
    }
    @Module({ controllers: [ThingsV1, NeutralThings, ThingsV2] })
    class Shared {}
    const versioning = RouteVersioning.of({ type: 'header', header: 'X-V' });

    const { versions } = await generateDocuments(
      describeRoutes(Shared, versioning),
      info,
      versioning,
    );

    expect(
      versions?.documents.get('1')?.document.paths['/things']?.get?.operationId,
    ).toBe('ThingsV1_list_v1');
    expect(
      versions?.documents.get('2')?.document.paths['/things']?.get?.operationId,
    ).toBe('NeutralThings_list');
  });

  it('keeps one document under URI versioning', async () => {
    const uri = RouteVersioning.of({ type: 'uri' });
    const generated = await generateDocuments(
      describeRoutes(AppModule, uri),
      info,
      uri,
    );

    expect(generated.versions).toBeUndefined();
  });
});

describe('the served per-version documents', () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const start = async (): Promise<TestServer> =>
    createTestServer({
      modules: OpenApiModule.forRoot({
        ...info,
        root: AppModule,
        renderer: new SwaggerRenderer(),
      }),
      versioning: { type: 'header', header: 'X-API-Version' },
    });

  it('answers ?version= with that version, and 404 for one it lacks', async () => {
    server = await start();

    const primary = (await (
      await server.request('/openapi.json')
    ).json()) as OpenApiDocument;
    const v1 = (await (
      await server.request('/openapi.json?version=1')
    ).json()) as OpenApiDocument;

    expect(Object.keys(primary.paths)).toContain('/users');
    expect(Object.keys(v1.paths)).not.toContain('/users');
    expect((await server.request('/openapi.json?version=9')).status).toBe(404);
    expect((await server.request('/docs?version=9')).status).toBe(404);
  });

  it('the page links every version, marking the one shown', async () => {
    server = await start();

    const html = await (await server.request('/docs?version=1')).text();

    expect(html).toContain(
      '<nav class="dunx-versions" aria-label="API version">Version ' +
        '<a href="/docs?version=1" aria-current="page">1</a>' +
        '<a href="/docs?version=2">2</a><a href="/docs?version=3">3</a></nav>',
    );
    expect(html).toContain('href="/openapi.json?version=1"');
    const primary = await (await server.request('/docs')).text();
    expect(primary).toContain('<a href="/docs?version=3" aria-current="page">');
  });
});
