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
 * better-auth's own endpoints, contributed to the app's OpenAPI document. It
 * serves `<basePath>/*` from its own handler, so route discovery sees none of it
 * and the document would omit the whole authentication surface.
 *
 * `forRootAsync`, not `forRoot`: the latter is evaluated while the module graph is
 * described, before there is a container to take `Auth` from.
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
 * A schema exists only with the `openAPI()` plugin enabled; without it this
 * contributes nothing rather than throwing. Paths are rewritten under `basePath`.
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
