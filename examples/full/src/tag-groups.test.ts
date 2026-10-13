import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { testClient, type TestClient } from '@dunx/testing';
import { createApp } from './main.js';
import { SelfOrigin } from './landing/self-origin.js';

/**
 * The tag hierarchy `createApp()` declares. `tagGroups` is a document-level
 * option, so it is asserted over the served JSON rather than through a
 * controller's metadata.
 *
 * Its own file so `service.test.ts` stays under the 800-line cap.
 */
let app: HttpApp;
let client: TestClient;

beforeAll(async () => {
  app = await createApp();
  const url = await app.listen(0);
  app.get(SelfOrigin).set(url);
  client = testClient(url);
});

afterAll(async () => {
  await app.shutdown();
});

it('serves the declared tag hierarchy as 3.1 x-tagGroups', async () => {
  const { body: document } = await client.json<{
    tags?: { name: string; parent?: string }[];
    'x-tagGroups'?: unknown;
  }>('api/openapi.json');

  expect(document['x-tagGroups']).toEqual([
    { name: 'Content', tags: ['Notes', 'Events', 'Demo'] },
    { name: 'Data', tags: ['Crud', 'Versioning'] },
    { name: 'Platform', tags: ['Wiring', 'Cookies'] },
  ]);
  // 3.1 carries the nesting here, so no tag repeats it as a 3.2 `parent`.
  for (const tag of document.tags ?? []) expect(tag.parent).toBeUndefined();
});
