import Fastify from 'fastify';
import type { z } from 'zod';
import {
  echo,
  jsonPayload,
  type Person,
  personSchema,
  PLAINTEXT,
  port,
} from './shared.js';

const app = Fastify({ logger: false });

// Swaps Fastify's ajv/JSON-Schema path for the same zod schema every other subject
// runs, so the validate scenario compares frameworks and not validators. Ajv
// compiles to straight-line JS and is faster than this - see the subject notes.
app.setValidatorCompiler(({ schema }) => {
  const zodSchema = schema as unknown as z.ZodType;
  return (data) => {
    const parsed = zodSchema.safeParse(data);
    return parsed.success ? { value: parsed.data } : { error: parsed.error };
  };
});

app.get('/plaintext', (_req, reply) => {
  void reply.type('text/plain; charset=utf-8').send(PLAINTEXT);
});

app.get('/json', () => jsonPayload());

app.get<{ Params: { id: string } }>('/params/:id', (req) => ({
  id: req.params.id,
}));

app.post<{ Body: Person }>(
  '/validate',
  { schema: { body: personSchema } },
  (req) => echo(req.body),
);

await app.listen({ port: port(), host: '127.0.0.1' });
