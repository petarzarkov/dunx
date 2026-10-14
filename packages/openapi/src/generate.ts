import type { HttpMethod } from '@dunx/http';
import type { DiscoveredRoute } from '@dunx/http/internal';
import { rolesOf } from './metadata.js';
import {
  bearerScheme,
  buildOperation,
  pathTemplate,
  SECURITY_SCHEME,
  type VersionHeader,
} from './operations.js';
import {
  danglingRefs,
  reachableComponents,
  SchemaStore,
  titledAs,
} from './refs.js';
import {
  OPERATION_ORDER,
  type ComponentsObject,
  type JsonSchema,
  type OpenApiDocument,
  type OperationKey,
  type OperationObject,
  type PathItemObject,
  type ServerObject,
  type SpecVersion,
  type TagGroup,
  type TagObject,
} from './types.js';

export interface DocumentInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly servers?: readonly ServerObject[];
  /**
   * Hierarchical grouping for the document's `tags`, declared beside the
   * document rather than on each operation.
   *
   * `Operation.tags` stays a flat list of names: an operation belongs to the
   * tags it names, and putting the nesting there too would make the same array
   * mean two things. The relationship is a property of the document, which is
   * where a viewer looks for it.
   */
  readonly tagGroups?: readonly TagGroup[];
  /**
   * Which OpenAPI specification to emit. Default `3.1.0`.
   *
   * `tagGroups` renders either way: 3.2 gained a native `parent` on the Tag
   * Object, so a 3.2 document carries the nesting itself and 3.1 carries it as
   * `x-tagGroups`, the extension Scalar and Redoc already read.
   */
  readonly specVersion?: SpecVersion;
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

/**
 * Something the container resolved that knows how to describe its own endpoints.
 *
 * A class rather than an interface, so it is an injection token as well as a
 * type - a contributor is normally a provider, reached through
 * `forRootAsync`'s `inject`:
 *
 * ```ts
 * export class AuthDocs extends DocumentSource {
 *   constructor(private readonly auth: Auth) {
 *     super();
 *   }
 *
 *   override async contribute(): Promise<DocumentFragment> {
 *     // `betterAuthDocument` defers: asking for the schema is async.
 *     return betterAuthDocument(this.auth, { basePath: '/api/auth' })();
 *   }
 * }
 *
 * OpenApiModule.forRootAsync({
 *   root: AppModule,
 *   inject: [AuthDocs],
 *   useFactory: (docs: AuthDocs) => ({ contribute: [docs] }),
 * });
 * ```
 *
 * Anything with a `contribute()` method satisfies it structurally, so extending
 * this class is optional and no adapter is needed either way.
 */
export abstract class DocumentSource {
  abstract contribute(): DocumentFragment | Promise<DocumentFragment>;
}

export type DocumentContributor =
  | DocumentFragment
  | DocumentSource
  | (() => DocumentFragment | Promise<DocumentFragment>);

/**
 * A fragment carries `paths`, `schemas` or `tags`; a source carries a
 * `contribute` method. Testing for the method rather than for the absence of the
 * others keeps an empty fragment - `{}`, which a contributor with nothing to add
 * legitimately returns - from being mistaken for one.
 */
const isSource = (entry: DocumentContributor): entry is DocumentSource =>
  typeof (entry as Partial<DocumentSource>).contribute === 'function';

export interface GeneratedDocument {
  readonly document: OpenApiDocument;
  /** Everything that degraded. Empty on a document that says all it could. */
  readonly warnings: readonly string[];
  /**
   * Paths that came from a contributor rather than from route discovery.
   *
   * These are already the URL the app serves: a contributor describes endpoints
   * dunx does not route, so they do not move when `setGlobalPrefix()` moves the
   * controllers. Applying the mount prefix to them produced `/api/api/auth/...`.
   */
  readonly absolutePaths: ReadonlySet<string>;
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
 *
 * A group's members are the one exception, added whether or not a route uses one
 * today: the hierarchy is a declaration about the document, not a reading of what
 * the routes happen to carry. Its own name is a tag only under 3.2, where the
 * nesting is that tag's children; under 3.1 the name stays a label in
 * `x-tagGroups`.
 *
 * Sorted by code unit, like the tags themselves: a generated document has to come
 * out byte-identical on every machine, and collation is locale-dependent.
 */
const tagsOf = (
  operations: readonly OperationObject[],
  groups: readonly TagGroup[],
  specVersion: SpecVersion,
): readonly TagObject[] => {
  const names = new Set<string>();
  for (const operation of operations) {
    for (const tag of operation.tags ?? []) names.add(tag);
  }

  const nesting = specVersion === '3.2.0';
  const parentOf = parentsOf(groups, nesting);
  const describedAs = new Map<string, string>();
  for (const group of groups) {
    for (const tag of group.tags) names.add(tag);
    if (!nesting) continue;
    names.add(group.name);
    if (group.description !== undefined)
      describedAs.set(group.name, group.description);
  }

  return [...names].sort().map((name) => {
    const description = describedAs.get(name);
    // Under 3.1 the nesting lives in `x-tagGroups`, so a tag carries no parent.
    const parent = nesting ? parentOf.get(name) : undefined;
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      ...(parent !== undefined ? { parent } : {}),
    };
  });
};

/**
 * Each member's group, refusing a declaration no viewer can draw: a tag in two
 * groups would silently keep the last, and under 3.2 a group reaching itself
 * through its members makes a `parent` chain with no root. Under 3.1 a group
 * name is only a label, so a group may share its name with a member.
 */
const parentsOf = (
  groups: readonly TagGroup[],
  nesting: boolean,
): Map<string, string> => {
  const parentOf = new Map<string, string>();
  for (const group of groups) {
    for (const tag of group.tags) {
      const earlier = parentOf.get(tag);
      if (earlier !== undefined)
        throw new Error(
          `Tag "${tag}" is in both the "${earlier}" and "${group.name}" tag groups. A tag nests under one group.`,
        );
      parentOf.set(tag, group.name);
    }
  }
  if (!nesting) return parentOf;
  for (const start of parentOf.keys()) {
    const seen = new Set<string>([start]);
    for (
      let at = parentOf.get(start);
      at !== undefined;
      at = parentOf.get(at)
    ) {
      if (seen.has(at))
        throw new Error(
          `Tag group "${at}" contains itself through ${[...seen].join(' > ')}.`,
        );
      seen.add(at);
    }
  }
  return parentOf;
};

/**
 * The tags a 3.1 viewer hides: Scalar and Redoc draw only grouped tags once
 * `x-tagGroups` is present, so a route under any other tag drops out of the
 * sidebar.
 */
const ungroupedWarning = (
  tags: readonly TagObject[],
  groups: readonly TagGroup[],
): string[] => {
  const grouped = new Set(groups.flatMap((group) => group.tags));
  const loose = tags.filter((tag) => !grouped.has(tag.name));
  return loose.length === 0
    ? []
    : [
        `Tag(s) in no tag group, which Scalar and Redoc hide under x-tagGroups: ${loose
          .map((tag) => tag.name)
          .join(', ')}`,
      ];
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
  versionHeader?: VersionHeader,
): Promise<GeneratedDocument> => {
  const store = new SchemaStore();
  const paths: Record<string, PathItemObject> = {};
  const operations: OperationObject[] = [];

  for (const route of ordered(routes)) {
    const template = pathTemplate(route.path);
    const item = (paths[template] ??= {});
    const operation = await buildOperation(route, store, versionHeader);
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

  const specVersion = info.specVersion ?? '3.1.0';
  const tagGroups = info.tagGroups ?? [];
  const grouped31 = specVersion === '3.1.0' && tagGroups.length > 0;

  const document: OpenApiDocument = {
    openapi: specVersion,
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
    tags: tagsOf(operations, tagGroups, specVersion),
    // 3.2 states the nesting on each tag, so the extension would say it twice.
    ...(grouped31
      ? {
          'x-tagGroups': tagGroups.map(({ name, tags }) => ({ name, tags })),
        }
      : {}),
    paths,
    components,
  };

  // Taken before the merge: only a name this generator hoisted may be pruned. A
  // contributor supplying a schema is asking for it in the document, referenced
  // or not.
  const generated = new Set(Object.keys(components.schemas));

  const merged = await mergeContributions(document, info.contribute ?? []);

  // After the merge, so a definition a contributed path refs is kept. Parameters
  // are expanded rather than referenced, so a `params` or `query` schema carrying
  // `.meta({ id })` would otherwise leave a component nothing points at.
  pruneOrphans(merged.document, generated);

  // A canary, not a guard: every `$ref` this generator writes is one it hoisted a
  // definition for, so a dangling one is a bug here rather than in the input.
  const dangling = danglingRefs(merged.document);
  const warnings = [
    ...store.warnings,
    ...merged.warnings,
    ...(grouped31
      ? ungroupedWarning(merged.document.tags ?? [], tagGroups)
      : []),
    ...(dangling.length > 0
      ? [`Unresolved $ref(s) in the generated document: ${dangling.join(', ')}`]
      : []),
  ];

  return {
    document: merged.document,
    warnings,
    absolutePaths: merged.absolutePaths,
  };
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
): Promise<{
  document: OpenApiDocument;
  warnings: string[];
  absolutePaths: ReadonlySet<string>;
}> => {
  const absolutePaths = new Set<string>();
  if (contributors.length === 0)
    return { document, warnings: [], absolutePaths };

  const warnings: string[] = [];
  const paths: Record<string, PathItemObject> = { ...document.paths };
  const schemas: Record<string, JsonSchema> = {
    ...document.components.schemas,
  };
  const tags = [...(document.tags ?? [])];

  for (const contributor of contributors) {
    let fragment: DocumentFragment;
    try {
      fragment = isSource(contributor)
        ? await contributor.contribute()
        : typeof contributor === 'function'
          ? await contributor()
          : contributor;
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
      absolutePaths.add(path);
    }

    for (const [name, schema] of Object.entries(fragment.schemas ?? {})) {
      if (schemas[name] !== undefined && schemas[name] !== schema) {
        warnings.push(
          `A contributor redefined the schema "${name}". The generated one was kept.`,
        );
        continue;
      }
      schemas[name] = titledAs(name, schema as JsonSchema);
    }

    // A name already present keeps what it has, a 3.2 `parent` included, and
    // takes only what it lacks, so a contributed description is not lost.
    for (const tag of fragment.tags ?? []) {
      const at = tags.findIndex((existing) => existing.name === tag.name);
      if (at === -1) tags.push(tag);
      else tags[at] = { ...tag, ...tags[at] };
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
    absolutePaths,
  };
};

/**
 * Removes every `components/schemas` entry nothing reaches. Mutates, because the
 * document has already been assembled and rebuilding it would reorder the keys a
 * caller may have diffed.
 */
const pruneOrphans = (
  document: { components: { schemas: Record<string, unknown> } },
  generated: ReadonlySet<string>,
): void => {
  const { schemas } = document.components;
  const reachable = reachableComponents(document, schemas);
  for (const name of Object.keys(schemas)) {
    if (generated.has(name) && !reachable.has(name)) delete schemas[name];
  }
};
