import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { testClient, type TestClient } from '@dunx/testing';
import { createApp } from './main.js';
import { SelfOrigin } from './landing/self-origin.js';

/**
 * The second renderer. `OpenApiModule` mounts one - Swagger UI, at `/api/docs` -
 * and `ReferenceMiddleware` holds a `ScalarRenderer` over the same
 * `OpenApiExplorer` document, so this asserts a renderer works as a plain object
 * outside the module too.
 *
 * Its own file so `service.test.ts` stays under the 800-line cap.
 */
let app: HttpApp;
let client: TestClient;

const raw = (path: string): Promise<Response> => client.request(`api/${path}`);

beforeAll(async () => {
  app = await createApp();
  const url = await app.listen(0);
  app.get(SelfOrigin).set(url);
  client = testClient(url);
});

afterAll(async () => {
  await app.shutdown();
});

it('serves the Scalar page beside the Swagger UI one', async () => {
  const page = await raw('reference');
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toContain('text/html');

  const html = await page.text();
  expect(html).toContain('Scalar.createApiReference');
  expect(html).toContain('"theme":"purple"');
  // The same document the JSON route serves, embedded rather than fetched.
  expect(html).toContain('UsersController_create');
  expect(html).toContain('/api/reference/standalone.js?v=');
  expect(html).not.toContain('jsdelivr');
});

it('serves the renderer own files, and nothing else from that install', async () => {
  const asset = await raw('reference/standalone.js');
  expect(asset.status).toBe(200);
  expect(asset.headers.get('content-type')).toContain('text/javascript');
  expect(asset.headers.get('cache-control')).toContain('immutable');

  // The allow-list is the renderer's: the rest of the package is a 404, not a
  // read out of node_modules.
  for (const name of ['package.json', 'standalone.esm.js', 'chunks/x.js']) {
    expect((await raw(`reference/${name}`)).status).toBe(404);
  }
});

it('leaves the Swagger UI page and the document where they were', async () => {
  expect((await raw('docs')).status).toBe(200);
  expect((await raw('openapi.json')).status).toBe(200);
});
