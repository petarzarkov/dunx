import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { echo, jsonPayload, personSchema, PLAINTEXT, port } from './shared.js';

export const app = new Hono()
  .get('/plaintext', (c) => c.text(PLAINTEXT))
  .get('/json', (c) => c.json(jsonPayload()))
  .get('/params/:id', (c) => c.json({ id: c.req.param('id') }))
  .post('/validate', zValidator('json', personSchema), (c) =>
    c.json(echo(c.req.valid('json'))),
  );

if (import.meta.main) {
  Bun.serve({ port: port(), fetch: app.fetch });
}
