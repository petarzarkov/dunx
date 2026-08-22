import { dirname } from 'node:path';

/**
 * Where `swagger-ui-dist` put its files, resolved from the consumer's install.
 *
 * dunx used to ship its own explorer - a React app in `internal/openapi-ui`, built
 * by Vite and inlined into the page as a 434 KiB string. It was deleted for the
 * reason `@dunx/queue-dashboard` was: a hand-built version of something mature
 * already does is the second half of Rule 1, and Swagger UI is the reference
 * implementation for reading an OpenAPI document.
 *
 * **The cost is real and is not hidden.** Swagger UI is 1.7 MiB against the old
 * bundle's 434 KiB, 443 KiB against 121 KiB gzipped - about 3.7x. That is why the
 * files are **served as two cacheable assets** rather than inlined the way the old
 * bundle was: inlining 1.7 MiB into every page response would send it again on
 * every load. See `SwaggerAssets.href`.
 *
 * Resolved **lazily**, on the first request that needs it, so `swagger-ui-dist`
 * stays an optional peer: an app that serves only `/openapi.json` never touches it
 * and does not have to install it. Async because that resolution reads a manifest
 * through `Bun.file`, and it is cached, so only the first request pays.
 */
export class SwaggerAssets {
  static #cached: SwaggerAssets | undefined;

  private constructor(
    /** The installed version, used to make `immutable` caching honest. */
    readonly version: string,
    readonly script: string,
    readonly style: string,
  ) {}

  /**
   * `swagger-ui-dist` has no `exports` map, so its `package.json` is reachable and
   * is the honest anchor: `main` is `index.js`, which is a CommonJS shim, and
   * resolving the asset files directly would work today and break the moment
   * upstream adds an `exports` map.
   */
  static async resolve(): Promise<SwaggerAssets> {
    if (SwaggerAssets.#cached) return SwaggerAssets.#cached;

    let manifestPath: string;
    try {
      manifestPath = Bun.resolveSync(
        'swagger-ui-dist/package.json',
        import.meta.dir,
      );
    } catch {
      throw new Error(
        'The API explorer needs swagger-ui-dist, which is an optional peer ' +
          'dependency of @dunx/openapi and is not installed. Run ' +
          '`bun add swagger-ui-dist`, or serve only the document and drop the ' +
          'page. The JSON route needs nothing extra.',
      );
    }

    const root = dirname(manifestPath);
    const { version } = (await Bun.file(manifestPath).json()) as {
      version?: string;
    };

    SwaggerAssets.#cached = new SwaggerAssets(
      version ?? '0',
      `${root}/swagger-ui-bundle.js`,
      `${root}/swagger-ui.css`,
    );
    return SwaggerAssets.#cached;
  }

  /**
   * The asset URL, with the installed version as a query parameter.
   *
   * A cache key is the whole URL, query included, so this both makes
   * `immutable` truthful and busts the cache on a `swagger-ui-dist` upgrade
   * without the path having to change. `StaticFiles` in `@dunx/http` documents the
   * same constraint: `immutable` is only honest for a name that changes with the
   * bytes.
   */
  href(
    mounted: string,
    file: 'swagger-ui-bundle.js' | 'swagger-ui.css',
  ): string {
    return `${mounted}/${file}?v=${encodeURIComponent(this.version)}`;
  }

  /** Only for tests, which need to observe the absent-package path. */
  static reset(): void {
    SwaggerAssets.#cached = undefined;
  }
}

/** One year, and honest because {@link SwaggerAssets.href} carries the version. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
