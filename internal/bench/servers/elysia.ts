import { Elysia } from 'elysia';
import { connectBunIo, readBunIo } from './io/bun.js';
import { ioEnabled } from './io/contract.js';
import { echo, jsonPayload, personSchema, PLAINTEXT, port } from './shared.js';

if (ioEnabled()) await connectBunIo();

// zod rather than Elysia's own TypeBox, via Standard Schema, so the validate
// scenario stays comparable. TypeBox is compiled and would be faster here.
const app = new Elysia()
  .get('/plaintext', () => new Response(PLAINTEXT))
  .get('/json', () => jsonPayload())
  .get('/params/:id', ({ params }) => ({ id: params.id }))
  .post('/validate', ({ body }) => echo(body), { body: personSchema });

if (ioEnabled()) app.get('/io', () => readBunIo());

app.listen(port());
