import type { ModuleRef } from '@dunx/core';
import { RouteVersioning } from '@dunx/http/internal';

/**
 * The OpenAPI document, from `@dunx/openapi` when the app has it. An optional peer
 * reached with `await import()`, so an app with no OpenAPI setup still gets a
 * working server and one that has it gets the real schemas.
 *
 * `describeRoutes` plus `generateDocuments` is the whole bridge, and both read the
 * module graph without constructing a controller.
 */
export interface OpenApiInput {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

interface OpenApiModule {
  readonly describeRoutes: (
    root: ModuleRef,
    versioning: RouteVersioning,
  ) => readonly unknown[];
  readonly generateDocuments: (
    routes: readonly never[],
    info: OpenApiInput,
    versioning: RouteVersioning,
  ) => Promise<{ readonly document: { readonly document: unknown } }>;
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

/**
 * The document `/openapi.json` serves without `?version=`: the one document,
 * or under header and media-type versioning the default version's.
 */
export const documentOf = async (
  root: ModuleRef,
  info: OpenApiInput,
  versioning: RouteVersioning = RouteVersioning.of(),
): Promise<unknown> => {
  const { describeRoutes, generateDocuments } = await load();
  const generated = await generateDocuments(
    describeRoutes(root, versioning) as readonly never[],
    info,
    versioning,
  );
  return generated.document.document;
};
