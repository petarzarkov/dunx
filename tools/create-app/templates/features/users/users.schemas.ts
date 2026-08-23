import type { RouteSchemas } from '@dunx/http';
import { z } from 'zod';

/**
 * Plain zod in a route's options: `z.object()` already carries `~standard`, the
 * whole contract `@dunx/http` validates against.
 *
 * Three traps. `.meta({ id })` names the `$defs` entry, and without it the schema
 * is inlined at every use site. Prose goes in `description` - Swagger UI labels a
 * schema by `title`, and `@dunx/openapi` fills that with the component name.
 * `.strict()` after `.meta()` discards the metadata, so put `.meta()` last.
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
 * The response side, never validated at runtime: the verb decorator holds the
 * handler's return type to it at compile time instead. That check caught this
 * schema advertising a `tags: string[]` the `users` table has no column for.
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

// A declared schema is what makes the matching `input` field exist and be
// parsed. `satisfies` keeps the literal types `Input<>` reads.
export const listUsers = {
  query: ListUsers,
  response: { 200: z.array(User) },
} as const satisfies RouteSchemas;
export const oneUser = {
  params: UserIndex,
  response: { 200: User, 404: NotFound },
} as const satisfies RouteSchemas;
export const createUser = {
  body: CreateUser,
  response: { 201: User },
} as const satisfies RouteSchemas;
