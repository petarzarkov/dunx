import type { BunRequest } from 'bun';
import type { DefaultStatus, HttpMethod } from './marker.js';

/**
 * Standard Schema v1, restated rather than depended on. The spec is an
 * *interface*, not a runtime: `@standard-schema/spec` ships nothing but these
 * declarations, so restating them costs one file and keeps `@dunx/http` at zero
 * dependencies. Zod 4, Valibot and ArkType already satisfy this shape, so any of
 * them drops straight into a route's options.
 */
export interface StandardSchemaV1<In = unknown, Out = In> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Out> | Promise<StandardSchemaResult<Out>>;
    readonly types?: { readonly input: In; readonly output: Out } | undefined;
  };
}

/** Success carries `value`; failure carries `issues`. `issues` discriminates. */
export type StandardSchemaResult<Out> =
  | { readonly value: Out; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] };

export interface StandardSchemaIssue {
  readonly message: string;
  /** Zod yields bare keys, Valibot `{ key }` objects. The spec allows both. */
  readonly path?:
    | readonly (PropertyKey | { readonly key: PropertyKey })[]
    | undefined;
}

/** The validated output of a schema - `InferOutput<typeof CreateNote>` is `Note`. */
export type InferOutput<S> =
  S extends StandardSchemaV1<unknown, infer Out> ? Out : never;

/**
 * A JSON Schema, as JSON. OpenAPI 3.1 embeds draft 2020-12 verbatim.
 *
 * Declared here rather than in `@dunx/openapi` because {@link RouteSchemas} names
 * it and that package depends on this one, so this is the lowest common owner.
 * `@dunx/openapi` re-exports it.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * The second argument to `@Get`/`@Post`/... Declaring a schema is what makes the
 * matching `input` field appear, get parsed, and get validated; omitting one
 * means the framework never touches it.
 */
export interface RouteSchemas {
  readonly body?: StandardSchemaV1;
  readonly query?: StandardSchemaV1;
  readonly params?: StandardSchemaV1;
  /** Overrides the default success status: 201 for POST, 200 otherwise. */
  readonly status?: number;
  /**
   * What the route answers with, keyed by status code, in the same Standard
   * Schema the request side takes - so a response schema with a `.meta({ id })`
   * hoists into `components/schemas` exactly as a request body does, and there is
   * one contract for both directions.
   *
   * ```ts
   * const one = {
   *   params: UserIndex,
   *   response: { 200: SanitizedUser, 404: Problem },
   * } as const satisfies RouteSchemas;
   * ```
   *
   * **Never validated at runtime, checked at compile time.** Running a validation
   * pass over every response body would be a per-request cost paid for a
   * documentation feature. The handler's own return type carries the check
   * instead: the verb decorators constrain it against the entry for the success
   * status, so a handler answering with a different shape is a `TS1241` naming
   * the mismatched property. See {@link Returns}. Nothing in the request path
   * reads this key.
   *
   * A plain {@link JsonSchema} is accepted here too, and only here: a JSON Schema
   * needs no conversion, so documenting a response costs no validator. `$id` names
   * it, hoisting it into `components/schemas` the way `.meta({ id })` does for a
   * zod schema. `body`, `query` and `params` still take a Standard Schema, because
   * those are parsed.
   *
   * ```ts
   * response: {
   *   200: Object.freeze({ $id: 'Pong', type: 'object' }),
   * }
   * ```
   */
  readonly response?: ResponseMap;
}

/** `response` keyed by status code. Named so {@link Returns} can constrain it. */
export type ResponseMap = Readonly<
  Record<number, StandardSchemaV1 | JsonSchema>
>;

/**
 * The handler's parameter type, derived from its own options object. It has to be
 * written out - a standard method decorator can *check* a parameter's type but
 * cannot contextually type an unannotated one
 * (docs/architecture/constraints.md) - but every field type still comes from the schemas, so nothing
 * is declared twice:
 *
 * ```ts
 * const createNote = { body: CreateNote, status: HttpStatusCode.CREATED } as const;
 *
 * @Post('/', createNote)
 * create(input: Input<typeof createNote>): Note {
 *   return this.notes.add(input.body.text);
 * }
 * ```
 *
 * Path params without a `params` schema stay on `input.req.params`.
 */
export type Input<O extends RouteSchemas> = {
  readonly req: BunRequest;
} & (O extends { body: infer B }
  ? { readonly body: InferOutput<B> }
  : unknown) &
  (O extends { query: infer Q }
    ? { readonly query: InferOutput<Q> }
    : unknown) &
  (O extends { params: infer P }
    ? { readonly params: InferOutput<P> }
    : unknown);

/**
 * The status a handler's return type is held to: an explicit `options.status`,
 * else the verb's default. Widened to `number` without `as const`, which is what
 * turns the check off rather than misapplying it.
 */
type SuccessStatus<O extends RouteSchemas, M extends HttpMethod> = O extends {
  status: infer S extends number;
}
  ? S
  : DefaultStatus<M>;

/**
 * A plain {@link JsonSchema} carries no type to infer, so it becomes `unknown` and
 * absorbs whatever the handler returns. That is the escape hatch for a response
 * whose shape no schema value describes.
 */
type Declared<S> = [InferOutput<S>] extends [never]
  ? unknown
  : Serialised<InferOutput<S>>;

/**
 * The declared shape as JSON will present it, which is the same shape with every
 * array made readonly.
 *
 * `z.array()` infers a mutable `T[]`, and `readonly T[]` is not assignable to it -
 * so a repository method returning `readonly User[]`, the correct signature for
 * something that must not be mutated, would fail against a document it satisfies.
 * Mutability does not survive `Response.json`, so it is not part of the contract.
 *
 * Only arrays need the rewrite; TypeScript already ignores a property's `readonly`
 * modifier when checking assignability. The object branch is how nested arrays are
 * reached, and functions are returned untouched because mapping over one would
 * discard its call signature.
 */
type Serialised<T> = T extends readonly (infer E)[]
  ? readonly Serialised<E>[]
  : T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { readonly [K in keyof T]: Serialised<T[K]> }
      : T;

/**
 * What a handler may return, given its own options object and its verb.
 *
 * A route decorator can *check* a handler's type but cannot *infer* it
 * (docs/architecture/constraints.md), and that cuts both ways: this is the return
 * half of the same guarantee `Input<O>` gives the parameter. Declaring
 * `response: { 200: User }` stops being documentation a handler can contradict.
 *
 * `Response` is always allowed - it is the escape hatch `buildRoutes` passes
 * through untouched. So is a promise of either. Nothing is checked when the
 * success status has no `response` entry.
 */
export type Returns<O extends RouteSchemas, M extends HttpMethod> =
  | SuccessBody<O, M>
  | Response
  | Promise<SuccessBody<O, M> | Response>;

/**
 * `infer R extends ResponseMap` is load bearing: without the constraint the
 * narrowed `O` inside the branch is `{ response: R } & O`, whose `response` no
 * longer satisfies `RouteSchemas`, and `SuccessStatus<O, M>` fails with `TS2344`.
 */
type SuccessBody<O extends RouteSchemas, M extends HttpMethod> = O extends {
  response: infer R extends ResponseMap;
}
  ? SuccessStatus<O, M> extends keyof R
    ? Declared<R[SuccessStatus<O, M>]>
    : unknown
  : unknown;

/** What the framework actually hands a handler; `Input<O>` is its typed view. */
export interface RouteInput {
  readonly req: BunRequest;
  readonly body?: unknown;
  readonly query?: unknown;
  readonly params?: unknown;
}
