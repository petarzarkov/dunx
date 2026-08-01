import { Elysia } from 'elysia';
import { echo, jsonPayload, personSchema, PLAINTEXT, port } from './shared.js';

// zod rather than Elysia's own TypeBox, via Standard Schema, so the validate
// scenario stays comparable. TypeBox is compiled and would be faster here.
new Elysia()
  .get('/plaintext', () => new Response(PLAINTEXT))
  .get('/json', () => jsonPayload())
  .get('/params/:id', ({ params }) => ({ id: params.id }))
  .post('/validate', ({ body }) => echo(body), { body: personSchema })
  .listen(port());
