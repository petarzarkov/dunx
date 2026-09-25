import { afterAll, beforeAll, expect, it } from 'bun:test';
import {
  createTestServer,
  testClient,
  type TestClient,
  type TestServer,
} from '@dunx/testing';
import { configModule } from './config.js';
import type { Color } from './crud/colors.controller.js';
import { CrudModule } from './crud/crud.module.js';

let server: TestServer;
let client: TestClient;

beforeAll(async () => {
  server = await createTestServer({
    modules: [configModule(), CrudModule],
    versioning: { type: 'uri' },
  });
  client = testClient(server.url);
});

afterAll(async () => {
  await server.close();
});

it('serves the handlers it inherits from CrudController', async () => {
  const list = await client.json<Color[]>('colors');
  const one = await client.json<Color>('colors/moss');

  expect(list.body.map((color) => color.id)).toEqual([
    'ember',
    'moss',
    'slate',
  ]);
  expect(one.body).toEqual({ id: 'moss', hex: '#5c940d' });
});

it('does not serve the handler exclude names', async () => {
  const res = await fetch(new URL('colors/moss', server.url), {
    method: 'DELETE',
  });

  expect(res.status).toBe(404);
  expect((await client.json<Color[]>('colors')).body).toHaveLength(3);
});

it('serves each swatches version at its own path', async () => {
  const v1 = await client.json<string[]>('v1/swatches');
  const v2 =
    await client.json<{ id: string; hex: string; rgb: number[] }[]>(
      'v2/swatches',
    );

  expect(v1.body).toEqual(['#e8590c', '#5c940d', '#495057']);
  expect(v2.body[0]).toEqual({
    id: 'ember',
    hex: '#e8590c',
    rgb: [232, 89, 12],
  });
  expect((await fetch(new URL('swatches', server.url))).status).toBe(404);
});

it('says version 1 is deprecated, and when it goes', async () => {
  const v1 = await fetch(new URL('v1/swatches', server.url));
  const v2 = await fetch(new URL('v2/swatches', server.url));

  expect(v1.headers.get('deprecation')).toBe('@1788220800');
  expect(v1.headers.get('sunset')).toBe('Mon, 01 Mar 2027 00:00:00 GMT');
  expect(v1.headers.get('link')).toBe(
    '<https://dunx.win/guide/versioning>; rel="deprecation"; type="text/html"',
  );
  expect(v2.headers.get('deprecation')).toBeNull();
});
