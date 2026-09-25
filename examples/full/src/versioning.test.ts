import { afterAll, beforeAll, expect, it } from 'bun:test';
import { createTestServer, type TestServer } from '@dunx/testing';
import { configModule } from './config.js';
import { CrudModule } from './crud/crud.module.js';

/*
 * The app serves URI versions (`main.ts`). The same two swatches controllers
 * under header versioning, with no change to either: one path, the version
 * read from `X-API-Version`.
 */
let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({
    modules: [configModule(), CrudModule],
    versioning: {
      type: 'header',
      header: 'X-API-Version',
      defaultVersion: '2',
    },
  });
});

afterAll(async () => {
  await server.close();
});

it('picks the version from the header, on one path', async () => {
  const v1 = await server.json<string[]>('swatches', {
    headers: { 'x-api-version': '1' },
  });
  const v2 = await server.json<{ id: string }[]>('swatches');

  expect(v1.body).toEqual(['#e8590c', '#5c940d', '#495057']);
  expect(v1.headers.get('deprecation')).toBe('@1788220800');
  expect(v1.headers.get('vary')).toBe('X-API-Version');
  expect(v2.body[0]?.id).toBe('ember');
  expect(v2.headers.get('deprecation')).toBeNull();
});

it('answers 404 for a version nobody declared', async () => {
  const res = await server.request('swatches', {
    headers: { 'x-api-version': '9' },
  });

  expect(res.status).toBe(404);
});
