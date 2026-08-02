import { normalizeBasePath } from './options.js';

/**
 * The shape `@dunx/openapi` accepts as a contribution. Restated here rather than
 * imported, for the same reason `DrizzleSource` restates `DbConnection`:
 * `@dunx/auth` must not depend on `@dunx/openapi`. An app that documents nothing
 * still uses this package, and an app that never mounts auth still uses that one.
 */
export interface AuthDocumentFragment {
  readonly paths: Readonly<Record<string, Record<string, unknown>>>;
  readonly schemas: Readonly<Record<string, unknown>>;
  readonly tags: readonly {
    readonly name: string;
    readonly description?: string;
  }[];
}

/**
 * Just enough of a Better Auth instance to ask it for its schema.
 *
 * `api` is `object` with the method optional on top, rather than an interface
 * whose only member is optional. Every-property-optional triggers TypeScript's
 * weak-type check, which rejects any argument sharing no property with it - so an
 * instance built without the `openAPI()` plugin failed to compile, and the doc
 * below promising it "contributes nothing rather than throwing" described a path
 * that could not be written.
 */
export interface OpenApiCapableAuth {
  readonly api: object & {
    generateOpenAPISchema?: () => Promise<unknown>;
  };
}

export interface AuthDocumentOptions {
  /**
   * Where the handler is mounted. Matches `AuthOptions.basePath`, including the
   * global prefix if there is one: these paths go into the document as-is and
   * are not moved again by `setGlobalPrefix()`.
   */
  readonly basePath: string;
  /** Tag every contributed operation carries. Default `auth`. */
  readonly tag?: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

interface RawSchema {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

/**
 * Better Auth's own endpoints, as a contribution to the app's OpenAPI document.
 *
 * Better Auth serves `<basePath>/*` from its own handler rather than from dunx
 * controllers, so route discovery cannot see any of it and the document would
 * describe an API missing its entire authentication surface. This asks the
 * library for its schema and hands it over:
 *
 * **`forRootAsync`, not `forRoot`.** `forRoot` is evaluated while the module graph
 * is being described, before there is a container, so there is nowhere for the
 * `Auth` instance to come from. The async pair injects it:
 *
 * ```ts
 * OpenApiModule.forRootAsync({
 *   root: AppModule,
 *   useFactory: (auth: Auth) => ({
 *     title: 'API',
 *     version: '1.0.0',
 *     contribute: [betterAuthDocument(auth, { basePath: '/api/auth' })],
 *   }),
 *   inject: [Auth],
 * });
 * ```
 *
 * Building a second `betterAuth()` purely to generate the schema is the workaround
 * this replaces, and it is not needed.
 *
 * **Better Auth only generates a schema when the `openAPI()` plugin is enabled.**
 * Without it `generateOpenAPISchema` is absent and this contributes nothing rather
 * than throwing, because a missing plugin should cost documentation and not boot.
 * Pass `openAPI({ disableDefaultReference: true })` if you want the schema without
 * Better Auth also mounting its own reference page next to the dunx one.
 *
 * Paths are rewritten to sit under `basePath`, since the library reports them
 * relative to its own mount.
 */
export const betterAuthDocument =
  (auth: OpenApiCapableAuth, options: AuthDocumentOptions) =>
  async (): Promise<AuthDocumentFragment> => {
    const empty: AuthDocumentFragment = { paths: {}, schemas: {}, tags: [] };
    if (typeof auth.api.generateOpenAPISchema !== 'function') return empty;

    const raw = (await auth.api.generateOpenAPISchema()) as RawSchema;
    const prefix = normalizeBasePath(options.basePath);
    const tag = options.tag ?? 'auth';

    const paths: Record<string, Record<string, unknown>> = {};
    for (const [path, item] of Object.entries(raw.paths ?? {})) {
      // Tagged so the explorer groups them, instead of scattering a dozen auth
      // endpoints through the rest of the API.
      for (const method of METHODS) {
        const operation = item[method];
        if (operation && typeof operation === 'object') {
          (operation as { tags?: string[] }).tags = [tag];
        }
      }
      paths[path.startsWith(prefix) ? path : `${prefix}${path}`] = item;
    }

    return {
      paths,
      schemas: raw.components?.schemas ?? {},
      tags: [{ name: tag, description: 'Served by Better Auth' }],
    };
  };
