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
  server = await createTestServer({ modules: [configModule(), CrudModule] });
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
