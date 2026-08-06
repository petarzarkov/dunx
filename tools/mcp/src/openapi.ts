import type { ModuleRef } from '@dunx/core';

/**
 * The OpenAPI document, from `@dunx/openapi` when the app has it.
 *
 * An **optional** peer dependency reached with `await import()`, so nothing here
 * loads unless the tool is called: an app with no OpenAPI setup still gets a
 * working server, and one that has it gets the real schemas rather than this
 * package's guess at them. `@dunx/openapi` derives them from the routes' own zod
 * schemas, which is work with a zod-shaped answer - restating any part of it here
 * would be a second, worse generator.
 *
 * `describeRoutes` + `generateDocument` is the whole bridge, and both read the
 * module graph without constructing a controller, so this tool costs the same
 * nothing the others do.
 */
export interface OpenApiInput {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

interface OpenApiModule {
  readonly describeRoutes: (root: ModuleRef) => readonly unknown[];
  readonly generateDocument: (
    routes: readonly never[],
    info: OpenApiInput,
  ) => Promise<{ readonly document: unknown; readonly warnings?: unknown }>;
}

/**
 * Named separately from the generic tool failure so the message can say what to
 * install. A missing optional peer is a setup answer, not a bug in the app being
 * read, and an agent that gets "Cannot find package" learns nothing from it.
 */
export class OpenApiUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      '@dunx/openapi is not installed in this app, so the OpenAPI document ' +
        'cannot be generated. Install it with `bun add @dunx/openapi zod`, or ' +
        'use dunx_routes, which reports which inputs each route validates ' +
        `without it. (${String(cause)})`,
    );
    this.name = 'OpenApiUnavailableError';
  }
}

const load = async (): Promise<OpenApiModule> => {
  try {
    // A bare specifier, resolved from the app being read rather than from this
    // package: the peer is the app's copy, and it is the app's routes it must see.
    return (await import('@dunx/openapi')) as unknown as OpenApiModule;
  } catch (error) {
    throw new OpenApiUnavailableError(error);
  }
};

export const documentOf = async (
  root: ModuleRef,
  info: OpenApiInput,
): Promise<unknown> => {
  const { describeRoutes, generateDocument } = await load();
  const generated = await generateDocument(
    describeRoutes(root) as readonly never[],
    info,
  );
  return generated.document;
};
