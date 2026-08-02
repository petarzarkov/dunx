import type { DiscoveredRoute, HttpMethod } from '@dunx/http';
import { rolesOf } from './metadata.js';
import {
  bearerScheme,
  buildOperation,
  pathTemplate,
  SECURITY_SCHEME,
} from './operations.js';
import { danglingRefs, SchemaStore } from './refs.js';
import {
  OPERATION_ORDER,
  type ComponentsObject,
  type JsonSchema,
  type OpenApiDocument,
  type OperationKey,
  type OperationObject,
  type PathItemObject,
  type ServerObject,
  type TagObject,
} from './types.js';

export interface DocumentInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly servers?: readonly ServerObject[];
  /**
   * Paths this generator cannot see, merged into the document.
   *
   * Routes served by something other than a dunx controller are invisible to
   * route discovery, so they are absent from the document even though they very
   * much exist. Better Auth is the motivating case: it mounts its own handler and
   * owns a dozen endpoints. `@dunx/auth` exports `betterAuthDocument()` which
   * returns one of these.
   *
   * A contributor may be async, because producing the fragment can mean asking
   * the library for its schema.
   */
  readonly contribute?: readonly DocumentContributor[];
}

/**
 * Paths, schemas and tags for endpoints route discovery cannot see.
 *
 * Deliberately looser than `OpenApiDocument`. A fragment describes endpoints some
 * other library owns, and its operations are that library's JSON: requiring them
 * to satisfy this generator's `OperationObject`, which insists on `operationId`
 * and `responses`, would make every real contribution unusable. They are passed
 * through unvalidated, which is the honest contract - dunx did not generate them
 * and cannot vouch for them.
 */
export interface DocumentFragment {
  readonly paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly schemas?: Readonly<Record<string, unknown>>;
  readonly tags?: readonly TagObject[];
}

export type DocumentContributor =
  | DocumentFragment
  | (() => DocumentFragment | Promise<DocumentFragment>);

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
// byte-identical on every machine, and collation is locale-dependent - it sorts
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

/**
 * Declared from the tags the operations **carry**, not from the controllers' class
 * names. Deriving them separately let a document declare tags nothing used and use
 * tags it never declared, which puts every viewer's sidebar at odds with its own
 * operation list. Reading them back off the built operations is what makes the two
 * agree by construction.
 */
const tagsOf = (
  operations: readonly OperationObject[],
): readonly TagObject[] => {
  const names = new Set<string>();
  for (const operation of operations) {
    for (const tag of operation.tags ?? []) names.add(tag);
  }
  return [...names].sort().map((name) => ({ name }));
};

/**
 * Routes to an OpenAPI 3.1 document. `routes` is exactly what
 * `discoverRoutes()` produced, so the document describes the table the server
 * actually serves - the schemas here are the objects the request path validates
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
  const operations: OperationObject[] = [];

  for (const route of ordered(routes)) {
    const template = pathTemplate(route.path);
    const item = (paths[template] ??= {});
    const operation = await buildOperation(route, store);
    item[METHOD_KEYS[route.method]] = operation;
    operations.push(operation);
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
    tags: tagsOf(operations),
    paths,
    components,
  };

  const merged = await mergeContributions(document, info.contribute ?? []);

  // A canary, not a guard: every `$ref` this generator writes is one it hoisted a
  // definition for, so a dangling one is a bug here rather than in the input.
  const dangling = danglingRefs(merged.document);
  const warnings = [
    ...store.warnings,
    ...merged.warnings,
    ...(dangling.length > 0
      ? [`Unresolved $ref(s) in the generated document: ${dangling.join(', ')}`]
      : []),
  ];

  return { document: merged.document, warnings };
};

/**
 * Folds every contributed fragment into the document.
 *
 * **A declared route always wins.** A contributor describes endpoints this
 * generator could not see, so a collision means it was wrong about that, and
 * silently replacing a real route's documentation with a guess is the worse
 * outcome. The collision becomes a warning, which is readable off
 * `OpenApiExplorer.warnings` right after boot.
 */
const mergeContributions = async (
  document: OpenApiDocument,
  contributors: readonly DocumentContributor[],
): Promise<{ document: OpenApiDocument; warnings: string[] }> => {
  if (contributors.length === 0) return { document, warnings: [] };

  const warnings: string[] = [];
  const paths: Record<string, PathItemObject> = { ...document.paths };
  const schemas: Record<string, JsonSchema> = {
    ...document.components.schemas,
  };
  const tags = [...(document.tags ?? [])];

  for (const contributor of contributors) {
    let fragment: DocumentFragment;
    try {
      fragment =
        typeof contributor === 'function' ? await contributor() : contributor;
    } catch (error) {
      // Best effort by design: a library that cannot produce its schema costs
      // some documentation, never the boot.
      warnings.push(
        `A document contributor threw and was skipped: ${String(error)}`,
      );
      continue;
    }

    for (const [path, item] of Object.entries(fragment.paths ?? {})) {
      if (paths[path] !== undefined) {
        warnings.push(
          `A contributor described "${path}", which a declared route already ` +
            'documents. The declared route was kept.',
        );
        continue;
      }
      // Foreign JSON, cast at the one boundary where it enters the document.
      paths[path] = item as PathItemObject;
    }

    for (const [name, schema] of Object.entries(fragment.schemas ?? {})) {
      if (schemas[name] !== undefined && schemas[name] !== schema) {
        warnings.push(
          `A contributor redefined the schema "${name}". The generated one was kept.`,
        );
        continue;
      }
      schemas[name] = schema as JsonSchema;
    }

    for (const tag of fragment.tags ?? []) {
      if (!tags.some((existing) => existing.name === tag.name)) tags.push(tag);
    }
  }

  return {
    document: {
      ...document,
      tags,
      paths,
      components: { ...document.components, schemas },
    },
    warnings,
  };
};
