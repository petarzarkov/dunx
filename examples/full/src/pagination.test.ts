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
 * `@dunx/infra/pagination/cursor`, and the notes route with its own body parser.
 * On its own server so `service.test.ts` stays under the 800-line cap.
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

it('adds a note from a text/plain body through the route bodyParser', async () => {
  const plain = (body: string, type = 'text/plain') =>
    client.json<string[]>('notes/plain', {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });

  const created = await plain('  from a plain body \n');
  expect(created.status).toBe(201);
  expect(created.body).toContain('from a plain body');

  // The parser owns media-type acceptance, and `CreateNote` still validates.
  expect(
    (await plain('with a charset', 'text/plain; charset=utf-8')).status,
  ).toBe(201);
  expect((await plain('{"text":"json"}', 'application/json')).status).toBe(415);
  expect((await plain('near miss', 'text/plain-extra')).status).toBe(415);
  expect((await plain('   ')).status).toBe(400);
});
