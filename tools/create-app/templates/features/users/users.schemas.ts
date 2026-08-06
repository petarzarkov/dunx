import type { RouteSchemas } from '@dunx/http';
import { z } from 'zod';

/**
 * Real zod, dropped straight into a route's options: `z.object()` already carries
 * `~standard` (vendor `zod`, version 1), which is the entire contract
 * `@dunx/http` validates against - so nothing adapts anything, and the framework
 * still depends on no validator.
 *
 * `.meta({ id })` names the definition zod emits under `$defs`, which is the slot
 * OpenAPI calls `components/schemas`. `.meta({ title })` lands inline. See
 * `UsersDemo` for the generated document.
 */
export const Tag = z
  .object({ label: z.string().min(1) })
  .meta({ id: 'Tag', title: 'A label attached to a user' });

export const CreateUser = z
  .object({
    name: z.string().min(1).max(40),
    tags: z.array(Tag).default([]),
  })
  .meta({ id: 'CreateUser', title: 'Create a user' });

/** Path params arrive as strings; `z.coerce` is where `:id` becomes a number. */
export const UserIndex = z
  .object({ id: z.coerce.number().int().min(1) })
  .meta({ id: 'UserIndex', title: 'A user id in the path' });

export const ListUsers = z
  .object({
    q: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .meta({ id: 'ListUsers', title: 'Filter and page the user list' });

/**
 * The response side. Same Standard Schema contract as a request, so it hoists into
 * `components/schemas` the same way - but it is **never validated**: it documents
 * what comes back, and the handler's return type is what checks it.
 */
export const User = z
  .object({
    id: z.number().int(),
    name: z.string(),
    tags: z.array(z.string()),
  })
  .meta({ id: 'User', title: 'A stored user' });

export const NotFound = z
  .object({ error: z.string(), status: z.literal(404) })
  .meta({ id: 'NotFound', title: 'Nothing at that id' });

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
