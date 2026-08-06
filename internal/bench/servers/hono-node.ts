import { serve } from '@hono/node-server';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { echo, jsonPayload, personSchema, PLAINTEXT, port } from './shared.js';

// Deliberately a copy of servers/hono.ts rather than an import of it: the point of
// this subject is that the app is identical and only the runtime differs, and that
// is easier to check side by side than to trace through a shared module.
const app = new Hono()
  .get('/plaintext', (c) => c.text(PLAINTEXT))
  .get('/json', (c) => c.json(jsonPayload()))
  .get('/params/:id', (c) => c.json({ id: c.req.param('id') }))
  .post('/validate', zValidator('json', personSchema), (c) =>
    c.json(echo(c.req.valid('json'))),
  );

serve({ fetch: app.fetch, port: port() });
