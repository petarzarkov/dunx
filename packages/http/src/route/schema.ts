import type { BunRequest } from 'bun';
import type { DefaultStatus, HttpMethod } from './marker.js';

/**
 * Standard Schema v1, restated rather than depended on: the spec is an interface,
 * so restating it keeps `@dunx/http` at zero dependencies. Zod 4, Valibot and
 * ArkType all satisfy this shape already.
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
 * A JSON Schema, as JSON. Declared here rather than in `@dunx/openapi` because
 * {@link RouteSchemas} names it and that package depends on this one.
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
   * Schema the request side takes.
   *
   * ```ts
   * const one = {
   *   params: UserIndex,
   *   response: { 200: SanitizedUser, 404: Problem },
   * } as const satisfies RouteSchemas;
   * ```
   *
   * Never validated at runtime, checked at compile time against the success
   * status. A plain {@link JsonSchema} is accepted here and only here, and `$id`
   * hoists it into `components/schemas`.
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
 * written out: a standard method decorator can check a parameter's type but not
 * contextually type an unannotated one (docs/architecture/constraints.md).
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
 * else the verb's default. Widened to `number` without `as const`, which turns
 * the check off rather than misapplying it.
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
 * The declared shape as JSON will present it: the same shape with every array made
 * readonly. `z.array()` infers a mutable `T[]`, so a method correctly returning
 * `readonly User[]` would fail against a document it satisfies, and mutability
 * does not survive `Response.json` anyway.
 *
 * Only arrays need it. The object branch reaches nested ones; functions are
 * returned untouched, since mapping over one discards its call signature.
 */
type Serialised<T> = T extends readonly (infer E)[]
  ? readonly Serialised<E>[]
  : T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { readonly [K in keyof T]: Serialised<T[K]> }
      : T;

/**
 * What a handler may return, given its options object and its verb. The return
 * half of the guarantee `Input<O>` gives the parameter, so `response: { 200: User }`
 * stops being documentation a handler can contradict.
 *
 * `Response` is always allowed, and so is a promise of either. Nothing is checked
 * when the success status has no `response` entry.
 */
export type Returns<O extends RouteSchemas, M extends HttpMethod> =
  | SuccessBody<O, M>
  | Response
  | Promise<SuccessBody<O, M> | Response>;

/**
 * `infer R extends ResponseMap` is required: without it the narrowed `O` is
 * `{ response: R } & O`, whose `response` no longer satisfies `RouteSchemas`, and
 * `SuccessStatus<O, M>` fails with `TS2344`.
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
