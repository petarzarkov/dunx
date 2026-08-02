import type { BunRequest } from 'bun';

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
   * **Never validated.** It documents the response; it does not enforce it.
   * Running a validation pass over every response body would be a per-request
   * cost paid for a documentation feature, which is the wrong trade - the
   * handler's own return type is what checks the answer, at compile time and for
   * free. Nothing in the request path reads this key.
   */
  readonly response?: Readonly<Record<number, StandardSchemaV1>>;
}

/**
 * The handler's parameter type, derived from its own options object. It has to be
 * written out - a standard method decorator can *check* a parameter's type but
 * cannot contextually type an unannotated one (docs/ARCHITECTURE.md, "Verified
 * constraints") - but every field type still comes from the schemas, so nothing
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

/** What the framework actually hands a handler; `Input<O>` is its typed view. */
export interface RouteInput {
  readonly req: BunRequest;
  readonly body?: unknown;
  readonly query?: unknown;
  readonly params?: unknown;
}
