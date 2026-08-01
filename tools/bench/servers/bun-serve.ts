import {
  echo,
  invalid,
  jsonPayload,
  personSchema,
  PLAINTEXT,
  port,
} from './shared.js';

// Handlers, not Bun's static-`Response` route form. A static Response is served
// from a precomputed buffer and would beat every framework here for reasons that
// have nothing to do with framework overhead — see README, "What is not measured".
Bun.serve({
  port: port(),
  routes: {
    '/plaintext': { GET: (): Response => new Response(PLAINTEXT) },
    '/json': { GET: (): Response => Response.json(jsonPayload()) },
    '/params/:id': {
      GET: (req): Response => Response.json({ id: req.params.id }),
    },
    '/validate': {
      POST: async (req): Promise<Response> => {
        const parsed = personSchema.safeParse(await req.json());
        if (!parsed.success) return Response.json(invalid, { status: 400 });
        return Response.json(echo(parsed.data));
      },
    },
  },
});
