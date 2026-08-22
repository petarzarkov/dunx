import type { RouteSchemas } from '@dunx/http';
import { z } from 'zod';

/**
 * Real zod, dropped straight into a route's options: `z.object()` already carries
 * `~standard` (vendor `zod`, version 1), which is the entire contract
 * `@dunx/http` validates against - so nothing adapts anything, and the framework
 * still depends on no validator.
 *
 * `.meta({ id })` names the definition zod emits under `$defs`, which is the slot
 * OpenAPI calls `components/schemas`. Without an id the schema is inlined at every
 * use site instead of referenced once.
 *
 * **Prose goes in `description`, not `title`.** In JSON Schema `title` is a short
 * display name, and Swagger UI labels a schema by it. A sentence there makes the
 * whole Schemas list read as prose: `User` shows up as "A stored user" and is
 * impossible to find.
 *
 * Leaving `title` out is right, and not because it is unused: `@dunx/openapi` fills
 * it in with the component name when a schema is hoisted, which is what makes the
 * item of `array<User>` read as `User` rather than as `object`.
 *
 * One more ordering trap: `.strict()` **after** `.meta()` discards the metadata, so
 * the schema is inlined despite declaring an id. Put `.meta()` last.
 *
 * See `UsersDemo` for the generated document.
 */
export const Tag = z
  .object({ label: z.string().min(1) })
  .meta({ id: 'Tag', description: 'A label attached to a user' });

export const CreateUser = z
  .object({
    name: z.string().min(1).max(40),
    tags: z.array(Tag).default([]),
  })
  .meta({ id: 'CreateUser', description: 'Create a user' });

/** Path params arrive as strings; `z.coerce` is where `:id` becomes a number. */
export const UserIndex = z
  .object({ id: z.coerce.number().int().min(1) })
  .meta({ id: 'UserIndex', description: 'A user id in the path' });

export const ListUsers = z
  .object({
    q: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .meta({ id: 'ListUsers', description: 'Filter and page the user list' });

/**
 * The response side. Same Standard Schema contract as a request, so it hoists into
 * `components/schemas` the same way - and it is **never validated at runtime**:
 * the verb decorator holds the handler's return type to it instead, so a route
 * declaring this cannot answer with anything else and still compile.
 *
 * That check is what caught this schema declaring a `tags: string[]` the `users`
 * table has no column for. Every user response advertised an array no handler
 * returned. `tags` stays on {@link CreateUser}, the request side, where it is
 * read - a documented response is a view of the row, and this one is the row.
 */
export const User = z
  .object({
    id: z.number().int(),
    name: z.string(),
  })
  .meta({ id: 'User', description: 'A stored user' });

export const NotFound = z
  .object({ error: z.string(), status: z.literal(404) })
  .meta({ id: 'NotFound', description: 'Nothing at that id' });

// Declaring a schema is what makes the matching `input` field exist, get parsed
// and get validated. `satisfies` keeps the literal types `Input<>` reads.
export const listUsers = {
  query: ListUsers,
  response: { 200: z.array(User) },
} as const satisfies RouteSchemas;
export const oneUser = {
  params: UserIndex,
  response: { 200: User, 404: NotFound },
} as const satisfies RouteSchemas;
// No status: POST defaults to 201, every other verb to 200.
export const createUser = {
  body: CreateUser,
  response: { 201: User },
} as const satisfies RouteSchemas;
