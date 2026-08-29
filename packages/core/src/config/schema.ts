/**
 * Standard Schema v1, restated rather than depended on: the spec is an
 * interface, so restating it keeps `@dunx/core` at zero dependencies. Zod 4,
 * Valibot and ArkType all satisfy this shape already.
 *
 * It lives here rather than in `@dunx/http` because both need it and core is the
 * one they share - `ConfigModule` takes a schema, and so does every route.
 * `@dunx/http` re-exports these three names, so its surface is unchanged.
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

/** `key.nested[0]` from either spelling of a path, for an error message. */
export const issuePath = (issue: StandardSchemaIssue): string =>
  (issue.path ?? [])
    .map((part) =>
      typeof part === 'object' && part !== null ? part.key : part,
    )
    .map(String)
    .join('.');
