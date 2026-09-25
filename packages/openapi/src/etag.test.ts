import { afterEach, describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Get } from '@dunx/http';
import { createTestServer, type TestServer } from '@dunx/testing';
import { OpenApiModule } from './module.js';

@Controller('users', { version: '1' })
class UsersV1Controller {
  @Get('')
  list(): string {
    return 'v1';
  }
}

@Controller('users', { version: '2' })
class UsersV2Controller {
  @Get(':id')
  one(): string {
    return 'v2';
  }
}

@Module({ controllers: [UsersV1Controller, UsersV2Controller] })
class AppModule {}

const STRONG = /^"[0-9a-f]{16}"$/;

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = (version = '1.0.0', etag = false): Promise<TestServer> =>
  createTestServer({
    modules: OpenApiModule.forRoot({
      title: 'Tagged',
      version,
      root: AppModule,
    }),
    versioning: { type: 'header', header: 'X-API-Version' },
    etag,
  });

const tagOf = async (path: string): Promise<string | null> => {
  const response = await server!.request(path);
  await response.text();
  return response.headers.get('etag');
};

describe('the served document', () => {
  it('carries a strong ETag, the same on every request', async () => {
    server = await start();
    const first = await tagOf('/openapi.json');
    expect(first).toMatch(STRONG);
    expect(await tagOf('/openapi.json')).toBe(first);
  });

  it('answers 304 to a matching If-None-Match, with etag off and on', async () => {
    for (const etag of [false, true]) {
      server = await start('1.0.0', etag);
      const tag = (await tagOf('/openapi.json'))!;
      const response = await server.request('/openapi.json', {
        headers: { 'if-none-match': `W/${tag}` },
      });
      expect([etag, response.status]).toEqual([etag, 304]);
      expect(await response.text()).toBe('');
      expect(response.headers.get('etag')).toBe(tag);

      const stale = await server.request('/openapi.json', {
        headers: { 'if-none-match': '"0000000000000000"' },
      });
      expect(stale.status).toBe(200);
      await stale.text();
      await server.close();
      server = undefined;
    }
  });

  it('gives each version document its own tag', async () => {
    server = await start();
    const v1 = await tagOf('/openapi.json?version=1');
    const v2 = await tagOf('/openapi.json?version=2');
    expect(v1).toMatch(STRONG);
    expect(v2).toMatch(STRONG);
    expect(v1).not.toBe(v2);
  });

  it('tags a document that changed between boots anew', async () => {
    server = await start('1.0.0');
    const before = await tagOf('/openapi.json');
    await server.close();
    server = await start('1.0.1');
    expect(await tagOf('/openapi.json')).not.toBe(before);
  });
});
