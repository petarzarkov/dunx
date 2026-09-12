import { afterAll, beforeAll, expect, it } from 'bun:test';
import {
  createTestServer,
  testClient,
  type TestClient,
  type TestServer,
} from '@dunx/testing';
import { configModule } from './config.js';
import { NotesModule } from './notes/notes.module.js';

/**
 * Keyset pagination over a list that is no database table, through
 * `@dunx/infra/pagination/cursor`. On its own server so `service.test.ts` stays
 * under the 800-line cap.
 */
let server: TestServer;
let client: TestClient;

interface NotePage {
  data: { id: string; text: string }[];
  meta: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    nextCursor: string | null;
  };
}

beforeAll(async () => {
  server = await createTestServer({ modules: [configModule(), NotesModule] });
  client = testClient(server.url);
});

afterAll(async () => {
  await server.close();
});

it('pages a list that is no database table', async () => {
  const first = await client.json<NotePage>('notes/page?take=1');

  expect(first.status).toBe(200);
  expect(first.body.data).toHaveLength(1);
  expect(first.body.meta.hasNextPage).toBe(true);
  expect(first.body.meta.hasPreviousPage).toBe(false);
});

it('walks forward on the cursor the envelope handed back', async () => {
  const first = await client.json<NotePage>('notes/page?take=1');
  const next = await client.json<NotePage>(
    `notes/page?take=1&cursor=${encodeURIComponent(first.body.meta.nextCursor ?? '')}`,
  );

  // The same opaque cursor a drizzle table hands back, from an import that
  // carries no query builder and resolves with no drizzle installed.
  expect(next.body.data[0]?.text).not.toBe(first.body.data[0]?.text);
  expect(next.body.meta.hasPreviousPage).toBe(true);
});
