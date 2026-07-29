import type { DiscoveredRoute, HttpMethod } from '@dunx/http';
import { rolesOf } from './metadata.js';
import {
  bearerScheme,
  buildOperation,
  pathTemplate,
  SECURITY_SCHEME,
  tagOf,
} from './operations.js';
import { danglingRefs, SchemaStore } from './refs.js';
import {
  OPERATION_ORDER,
  type ComponentsObject,
  type OpenApiDocument,
  type OperationKey,
  type PathItemObject,
  type ServerObject,
  type TagObject,
} from './types.js';

export interface DocumentInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly servers?: readonly ServerObject[];
}

export interface GeneratedDocument {
  readonly document: OpenApiDocument;
  /** Everything that degraded. Empty on a document that says all it could. */
  readonly warnings: readonly string[];
}

const METHOD_KEYS: Readonly<Record<HttpMethod, OperationKey>> = Object.freeze({
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  PATCH: 'patch',
  DELETE: 'delete',
});

// Code-unit order, not `localeCompare`: a generated document has to come out
// byte-identical on every machine, and collation is locale-dependent — it sorts
// `/reports/{id}` before `/reports/health` under ICU and after it without.
const ordered = (routes: readonly DiscoveredRoute[]): DiscoveredRoute[] =>
  [...routes].sort((left, right) => {
    const leftPath = pathTemplate(left.path);
    const rightPath = pathTemplate(right.path);
    if (leftPath !== rightPath) return leftPath < rightPath ? -1 : 1;
    return (
      OPERATION_ORDER.indexOf(METHOD_KEYS[left.method]) -
      OPERATION_ORDER.indexOf(METHOD_KEYS[right.method])
    );
  });

const tagsOf = (routes: readonly DiscoveredRoute[]): readonly TagObject[] =>
  [...new Set(routes.map(tagOf))].sort().map((name) => ({ name }));

/**
 * Routes to an OpenAPI 3.1 document. `routes` is exactly what
 * `discoverRoutes()` produced, so the document describes the table the server
 * actually serves — the schemas here are the objects the request path validates
 * against, not a reconstruction of them.
 *
 * Async because zod is a `peerDependency` loaded on demand. Nothing throws: a
 * schema that cannot be converted becomes a permissive one and a warning.
 */
export const generateDocument = async (
  routes: readonly DiscoveredRoute[],
  info: DocumentInfo,
): Promise<GeneratedDocument> => {
  const store = new SchemaStore();
  const paths: Record<string, PathItemObject> = {};

  for (const route of ordered(routes)) {
    const template = pathTemplate(route.path);
    const item = (paths[template] ??= {});
    item[METHOD_KEYS[route.method]] = await buildOperation(route, store);
  }

  const guarded = routes.some((route) => rolesOf(route.meta) !== undefined);
  const components: ComponentsObject = {
    schemas: store.snapshot(),
    ...(guarded
      ? { securitySchemes: { [SECURITY_SCHEME]: bearerScheme } }
      : {}),
  };

  const document: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      ...(info.description !== undefined
        ? { description: info.description }
        : {}),
    },
    ...(info.servers !== undefined && info.servers.length > 0
      ? { servers: info.servers }
      : {}),
    tags: tagsOf(routes),
    paths,
    components,
  };

  // A canary, not a guard: every `$ref` this generator writes is one it hoisted a
  // definition for, so a dangling one is a bug here rather than in the input.
  const dangling = danglingRefs(document);
  const warnings =
    dangling.length > 0
      ? [
          ...store.warnings,
          `Unresolved $ref(s) in the generated document: ${dangling.join(', ')}`,
        ]
      : store.warnings;

  return { document, warnings };
};
