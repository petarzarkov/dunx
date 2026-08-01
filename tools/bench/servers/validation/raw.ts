/**
 * The raw `Bun.serve` side of the validation decomposition. Four routes, each
 * doing strictly more than the one before it, so the drop from the `json` number
 * to the `validate` number can be attributed instead of guessed at:
 *
 * - `/json`     GET, no request body at all — the anchor.
 * - `/discard`  POST with the body on the wire, never read — transport only.
 * - `/parse`    POST, `await req.json()` — adds the parse.
 * - `/validate` POST, parse plus `$VALIDATOR` — adds the validator.
 *
 * Every route answers the same bytes, so the load generator is doing identical
 * work in all four cases.
 */
import { echo, invalid, jsonPayload, PLAINTEXT, port } from '../shared.js';
import type { Person } from '../shared.js';
import { loadSchema, validatorFromEnv } from './schemas.js';

const schema = await loadSchema(validatorFromEnv());
const { validate } = schema['~standard'];

const FIXED = { name: 'Ada Lovelace', age: 36 } as const;

Bun.serve({
  port: port(),
  routes: {
    '/plaintext': { GET: (): Response => new Response(PLAINTEXT) },
    '/json': { GET: (): Response => Response.json(jsonPayload()) },
    '/discard': { POST: (): Response => Response.json(FIXED) },
    '/parse': {
      POST: async (req): Promise<Response> =>
        Response.json(echo((await req.json()) as Person)),
    },
    '/validate': {
      POST: async (req): Promise<Response> => {
        // No `await` on the validator: a sync Standard Schema returns a plain
        // result, and awaiting it would put the very cost being measured into the
        // baseline dunx is compared against.
        const result = validate(await req.json());
        const settled = result instanceof Promise ? await result : result;
        if (settled.issues !== undefined) {
          return Response.json(invalid, { status: 400 });
        }
        return Response.json(echo(settled.value));
      },
    },
  },
});
